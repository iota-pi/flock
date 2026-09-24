import type { Repo } from '@automerge/automerge-repo/slim'
import { chunk } from 'lodash'

import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { buildSnapshot } from './snapshotBuilder'
import { RecoveryManager } from './RecoveryManager'
import { SyncApiClient } from './SyncApiClient'
import { classifySyncError } from './utils/errorClassifier'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { AbortError, isAbortError } from '../utils/abort'
import {
  SizeAwareBatchAccumulator,
  DEFAULT_MAX_BATCH_BYTES,
} from '../utils/SizeAwareBatchAccumulator'
import { estimateSnapshotSize } from './SnapshotBatchAccumulator'
import type { ItemId } from 'src/shared/schemas/items'
import type { VaultSnapshotInput } from 'src/shared/schemas/snapshots'

const MAX_BATCH_RETRIES = 3
export const REENCRYPT_RETRY_DELAYS = DEFAULT_RETRY_DELAYS
export const DEFAULT_BATCH_RETRY_DELAYS = [0, 0, 0] as const

function toAuthExpiredError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  return new Error(`Re-encryption aborted: authentication session expired (${message})`, {
    cause: err,
  })
}

async function quarantineItem(
  recoveryManager: RecoveryManager,
  accountId: string,
  itemId: ItemId,
  reason: string
): Promise<void> {
  try {
    await recoveryManager.quarantine(accountId, itemId, reason)
  } catch (storageErr) {
    console.error(`[reencryptAllItems] Failed to quarantine item ${itemId}:`, storageErr)
  }
}


export interface ReencryptDeps {
  accountId: string
  repo: Repo
  indexManager: AutomergeIndexManager
  apiClient?: SyncApiClient
  getAuthToken?: () => Promise<string | null>
  refreshAuthToken?: () => Promise<string | null>
  scheduleRetry?: (delayMs?: number) => void
  recoveryManager?: RecoveryManager
  reencryptor?: ItemReencryptor
  signal?: AbortSignal
  batchRetryDelays?: readonly number[]
}

export interface ReencryptResult {
  succeeded: ItemId[]
  failed: Array<{ itemId: ItemId; error: string }>
}

async function buildSingleSnapshotWithRetry(
  repo: Repo,
  itemId: ItemId,
  signal?: AbortSignal,
  batchRetryDelays?: readonly number[]
) {
  return await RetryStrategy.executeWithRetry(
    async () => buildSnapshot(repo, itemId, 0),
    {
      maxAttempts: MAX_BATCH_RETRIES,
      delays: batchRetryDelays ?? DEFAULT_BATCH_RETRY_DELAYS,
      signal,
      onRetry: (err, attempt) => {
        console.warn(
          `[reencryptAllItems] Retry ${attempt}/${MAX_BATCH_RETRIES} building snapshot for ${itemId}:`,
          err
        )
      },
    }
  )
}

async function buildSnapshotsForChunk(
  repo: Repo,
  chunkIds: ItemId[],
  signal?: AbortSignal,
  batchRetryDelays?: readonly number[]
): Promise<{
  readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>
  failureDetails: Array<{ itemId: ItemId; errorMsg: string; rawError?: unknown }>
}> {
  const settled = await Promise.allSettled(
    chunkIds.map(itemId => buildSingleSnapshotWithRetry(repo, itemId, signal, batchRetryDelays))
  )

  const readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }> = []
  const failureDetails: Array<{ itemId: ItemId; errorMsg: string; rawError?: unknown }> = []

  for (const [index, result] of settled.entries()) {
    const itemId = chunkIds[index]
    if (result.status === 'fulfilled') {
      if (result.value.type === 'success') {
        readySnapshots.push({ itemId, snapshot: result.value.snapshot })
      } else if (result.value.type === 'not-ready') {
        console.warn(`[reencryptAllItems] Item ${itemId} was not ready. Skipping.`)
      } else if (result.value.type === 'error') {
        const errorMsg = result.value.reason
          ? `Failed to build snapshot for item ${itemId}: ${result.value.reason}`
          : `Failed to build snapshot for item ${itemId}`
        failureDetails.push({ itemId, errorMsg })
      }
    } else {
      if (signal?.aborted || isAbortError(result.reason)) {
        throw result.reason
      }
      const errorDetail =
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      failureDetails.push({
        itemId,
        errorMsg: `Failed to build snapshot for item ${itemId}: ${errorDetail}`,
        rawError: result.reason,
      })
    }
  }

  return { readySnapshots, failureDetails }
}

async function uploadSnapshotBatchWithRetry(
  apiClient: SyncApiClient,
  accountId: string,
  readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>,
  signal?: AbortSignal,
  batchRetryDelays?: readonly number[]
): Promise<{ uploadSuccess: boolean; lastError: unknown }> {
  try {
    return await RetryStrategy.executeWithRetry(
      async attempt => {
        try {
          const response = await apiClient.putSnapshots(
            {
              account: accountId,
              snapshots: readySnapshots.map(r => r.snapshot),
            },
            signal ? { signal } : undefined
          )

          if (
            response?.success &&
            (response.persisted === undefined || response.persisted === readySnapshots.length)
          ) {
            return { uploadSuccess: true, lastError: null }
          }

          throw new Error(
            `Upload unconfirmed: response success=${response?.success}, persisted=${response?.persisted}/${readySnapshots.length}`
          )
        } catch (err) {
          console.warn(
            `[reencryptAllItems] Attempt ${attempt} failed to upload snapshots for batch:`,
            err
          )

          const classified = classifySyncError(err)
          if (classified.isAuth) {
            throw toAuthExpiredError(err)
          }

          throw err
        }
      },
      {
        maxAttempts: MAX_BATCH_RETRIES,
        delays: batchRetryDelays ?? DEFAULT_BATCH_RETRY_DELAYS,
        signal,
        shouldRetry: err => {
          const classified = classifySyncError(err)
          if (classified.isAuth) {
            return false
          }
          if (classified.isNetwork || classified.isServerError) {
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
              return false
            }
          }
          return true
        },
      }
    )
  } catch (err) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new AbortError(typeof signal.reason === 'string' ? signal.reason : 'Re-encryption aborted')
    }
    if (isAbortError(err)) {
      throw err
    }
    const classified = classifySyncError(err)
    if (classified.isAuth) {
      throw toAuthExpiredError(err)
    }
    return { uploadSuccess: false, lastError: err }
  }
}

// Use a slightly smaller upload chunk size than in SnapshotManager to improve progress reporting granularity
const REENCRYPT_CHUNK_SIZE = 10

export interface ItemReencryptorOptions {
  retryDelays?: number[]
  batchRetryDelays?: readonly number[]
  maxBatchCount?: number
  maxBatchBytes?: number
}

export class ItemReencryptor {
  private readonly retryStrategy: RetryStrategy
  private scheduledRetryTimeoutId: ReturnType<typeof setTimeout> | null = null
  public readonly maxBatchCount: number
  public readonly maxBatchBytes: number
  public readonly batchRetryDelays: readonly number[]

  constructor(options?: ItemReencryptorOptions) {
    this.retryStrategy = new RetryStrategy({ delays: options?.retryDelays ?? DEFAULT_RETRY_DELAYS })
    this.batchRetryDelays = options?.batchRetryDelays ?? DEFAULT_BATCH_RETRY_DELAYS
    this.maxBatchCount = options?.maxBatchCount ?? REENCRYPT_CHUNK_SIZE
    this.maxBatchBytes = options?.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  }

  get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  cancelScheduled(): void {
    if (this.scheduledRetryTimeoutId !== null) {
      clearTimeout(this.scheduledRetryTimeoutId)
      this.scheduledRetryTimeoutId = null
    }
    this.retryStrategy.reset()
  }

  scheduleRetry(
    deps: ReencryptDeps,
    onProgress?: (done: number, total: number) => void
  ): number {
    const delayMs = this.retryStrategy.nextDelay()

    console.warn(
      `[reencryptAllItems] Scheduling re-encryption retry (attempt ${this.retryStrategy.attempt}) in ${delayMs}ms`
    )

    if (deps.scheduleRetry) {
      deps.scheduleRetry(delayMs)
    } else {
      if (this.scheduledRetryTimeoutId !== null) {
        clearTimeout(this.scheduledRetryTimeoutId)
      }
      this.scheduledRetryTimeoutId = setTimeout(() => {
        this.scheduledRetryTimeoutId = null
        void this.reencryptAllItems(deps, onProgress).catch(err => {
          console.warn('[reencryptAllItems] Scheduled retry failed:', err)
        })
      }, delayMs)
    }

    return delayMs
  }

  private handleBatchUploadFailure(
    lastError: unknown,
    deps: ReencryptDeps,
    onProgress?: (done: number, total: number) => void
  ): string {
    const classified = classifySyncError(lastError)
    if (classified.isAuth) {
      throw toAuthExpiredError(lastError)
    }

    if (classified.isNetwork || classified.isServerError) {
      const errMsg = classified.message || (lastError instanceof Error ? lastError.message : String(lastError))
      const errorType = classified.isServerError ? 'server error' : 'network error'
      console.warn(
        `[reencryptAllItems] Transient ${errorType} during upload: ${errMsg}. Aborting operation and scheduling retry.`
      )
      this.scheduleRetry(deps, onProgress)
      throw new Error(
        `Re-encryption aborted: ${errorType} (${errMsg})`,
        { cause: lastError }
      )
    }

    return (
      `Failed to upload snapshots for batch after ${MAX_BATCH_RETRIES} attempts` +
      (lastError instanceof Error ? `: ${lastError.message}` : '')
    )
  }

  async reencryptAllItems(
    deps: ReencryptDeps,
    onProgress?: (done: number, total: number) => void
  ): Promise<ReencryptResult> {
    if (!deps?.accountId || !deps?.repo || !deps?.indexManager) {
      throw new Error('SyncWorker not initialized')
    }

    const { accountId, repo, indexManager } = deps
    const recoveryManager = deps.recoveryManager ?? new RecoveryManager({ accountId })
    const apiClient = deps.apiClient ?? new SyncApiClient({
      getAuthToken: deps.getAuthToken,
      refreshAuthToken: deps.refreshAuthToken,
    })
    const initialToken = await apiClient.getValidToken()
    if (!initialToken) {
      throw new Error('No active session token available')
    }

    const allItemIds = await indexManager.listAutomergeItemIds()
    const total = allItemIds.length
    if (total === 0) {
      if (onProgress) {
        onProgress(0, 0)
      }
      this.retryStrategy.reset()
      return { succeeded: [], failed: [] }
    }

    let processed = 0
    const succeeded: ItemId[] = []
    const failed: Array<{ itemId: ItemId; error: string }> = []

    const itemChunks = chunk(allItemIds, REENCRYPT_CHUNK_SIZE)
    const batchRetryDelays = deps.batchRetryDelays ?? this.batchRetryDelays

    for (const chunkIds of itemChunks) {
      if (deps.signal?.aborted) {
        throw deps.signal.reason instanceof Error
          ? deps.signal.reason
          : new AbortError(typeof deps.signal.reason === 'string' ? deps.signal.reason : 'Re-encryption aborted')
      }

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const errMsg = 'Network is offline'
        console.warn(`[reencryptAllItems] Aborting: ${errMsg}`)
        this.scheduleRetry(deps, onProgress)
        throw new Error(`Re-encryption aborted: network error (${errMsg})`)
      }

      await apiClient.syncLatestToken()

      const { readySnapshots, failureDetails } = await buildSnapshotsForChunk(
        repo,
        chunkIds,
        deps.signal,
        batchRetryDelays
      )
      for (const failure of failureDetails) {
        if (failure.rawError !== undefined) {
          console.error(`[reencryptAllItems] ${failure.errorMsg}`, failure.rawError)
        } else {
          console.error(`[reencryptAllItems] ${failure.errorMsg}`)
        }
        failed.push({ itemId: failure.itemId, error: failure.errorMsg })
        await quarantineItem(
          recoveryManager,
          accountId,
          failure.itemId,
          `Re-encryption snapshot build failed: ${failure.errorMsg}`
        )
      }

      if (readySnapshots.length > 0) {
        const snapshotBatches = SizeAwareBatchAccumulator.batch(readySnapshots, {
          maxBatchCount: this.maxBatchCount,
          maxBatchBytes: this.maxBatchBytes,
          calculateSize: item => estimateSnapshotSize(item.snapshot),
        })

        for (const batch of snapshotBatches) {
          const { uploadSuccess, lastError } = await uploadSnapshotBatchWithRetry(
            apiClient,
            accountId,
            batch,
            deps.signal,
            batchRetryDelays
          )

          if (uploadSuccess) {
            for (const item of batch) {
              succeeded.push(item.itemId)
            }
          } else {
            const errMsg = this.handleBatchUploadFailure(lastError, deps, onProgress)
            console.error(`[reencryptAllItems] ${errMsg}`)
            for (const item of batch) {
              failed.push({ itemId: item.itemId, error: errMsg })
              await quarantineItem(
                recoveryManager,
                accountId,
                item.itemId,
                `Re-encryption upload failed: ${errMsg}`
              )
            }
          }
        }
      }

      processed += chunkIds.length
      if (onProgress) {
        onProgress(Math.min(processed, total), total)
      }
    }

    this.retryStrategy.reset()
    return { succeeded, failed }
  }
}

export const defaultItemReencryptor = new ItemReencryptor()

export function cancelScheduledReencryption(): void {
  defaultItemReencryptor.cancelScheduled()
}

export async function reencryptAllItems(
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): Promise<ReencryptResult> {
  const coordinator = deps.reencryptor ?? defaultItemReencryptor
  return coordinator.reencryptAllItems(deps, onProgress)
}
