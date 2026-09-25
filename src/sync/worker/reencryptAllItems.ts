import type { Repo } from '@automerge/automerge-repo/slim'
import { chunk } from 'lodash'

import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { buildSnapshot as buildSnapshotFromBuilder, type BuildSnapshotResult } from './snapshotBuilder'
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
import { SYNC_BATCH_SIZES } from '../syncConfig'

const MAX_BATCH_RETRIES = 3
export const REENCRYPT_RETRY_DELAYS = DEFAULT_RETRY_DELAYS
export const DEFAULT_BATCH_RETRY_DELAYS = [0, 0, 0] as const
export const REENCRYPT_CHUNK_SIZE = SYNC_BATCH_SIZES.reencryptChunk

function toAuthExpiredError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  return new Error(`Re-encryption aborted: authentication session expired (${message})`, {
    cause: err,
  })
}

async function quarantineItem(
  recoveryManager: RecoveryManager,
  itemId: ItemId,
  reason: string
): Promise<void> {
  try {
    await recoveryManager.quarantine(itemId, reason)
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

export interface ProcessChunkContext {
  accountId: string
  repo: Repo
  apiClient: SyncApiClient
  recoveryManager: RecoveryManager
  batchRetryDelays?: readonly number[]
  deps?: ReencryptDeps
  onProgress?: (done: number, total: number) => void
  total?: number
  processedCount?: number
}

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

  private activeContext?: ProcessChunkContext
  private activeProgressCallback?: (done: number, total: number) => void

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

  handleBatchUploadFailure(
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

  async quarantineItem(
    itemId: ItemId,
    reason: string,
    recoveryManager?: RecoveryManager
  ): Promise<void> {
    const manager = recoveryManager ?? this.activeContext?.recoveryManager
    if (!manager) {
      console.error(`[reencryptAllItems] Failed to quarantine item ${itemId}: No RecoveryManager available`)
      return
    }
    await quarantineItem(manager, itemId, reason)
  }

  // --- Pipeline Stages ---

  /**
   * Stage 1: Partition all item IDs into plan chunks.
   */
  buildReencryptionPlan(
    allItemIds: ItemId[],
    chunkSize: number = REENCRYPT_CHUNK_SIZE
  ): ItemId[][] {
    return chunk(allItemIds, chunkSize)
  }

  /**
   * Stage 2a (pure operation): Build snapshot for an item.
   */
  async buildSnapshot(
    itemIdOrRepo: ItemId | Repo,
    repoOrItemId?: Repo | ItemId
  ): Promise<BuildSnapshotResult> {
    let repo: Repo | undefined
    let itemId: ItemId | undefined

    if (typeof itemIdOrRepo === 'string') {
      itemId = itemIdOrRepo as ItemId
      if (typeof repoOrItemId === 'object' && repoOrItemId !== null) {
        repo = repoOrItemId as Repo
      } else {
        repo = this.activeContext?.repo
      }
    } else {
      repo = itemIdOrRepo as Repo
      itemId = repoOrItemId as ItemId
    }

    if (!repo) {
      throw new Error('Automerge Repo is required to build snapshot')
    }
    if (!itemId) {
      throw new Error('ItemId is required to build snapshot')
    }

    return buildSnapshotFromBuilder(repo, itemId, 0)
  }

  /**
   * Stage 2b (pure operation): Upload batch of snapshots.
   */
  async uploadBatch(
    snapshots: VaultSnapshotInput[] | Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>,
    options?: { apiClient?: SyncApiClient; accountId?: string; signal?: AbortSignal }
  ): Promise<void>
  async uploadBatch(
    apiClient: SyncApiClient,
    accountId: string,
    snapshots: VaultSnapshotInput[] | Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>,
    signal?: AbortSignal
  ): Promise<void>
  async uploadBatch(
    arg1: SyncApiClient | VaultSnapshotInput[] | Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>,
    arg2?: string | { apiClient?: SyncApiClient; accountId?: string; signal?: AbortSignal },
    arg3?: VaultSnapshotInput[] | Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>,
    arg4?: AbortSignal
  ): Promise<void> {
    let apiClient: SyncApiClient | undefined
    let accountId: string | undefined
    let rawSnapshots: VaultSnapshotInput[] | Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>
    let signal: AbortSignal | undefined

    if (Array.isArray(arg1)) {
      rawSnapshots = arg1
      const opts = typeof arg2 === 'object' ? arg2 : undefined
      apiClient = opts?.apiClient ?? this.activeContext?.apiClient
      accountId = opts?.accountId ?? this.activeContext?.accountId
      signal = opts?.signal ?? this.activeContext?.deps?.signal
    } else {
      apiClient = arg1 as SyncApiClient
      accountId = arg2 as string
      rawSnapshots = arg3!
      signal = arg4
    }

    if (!apiClient || !accountId) {
      throw new Error('SyncApiClient and accountId are required to upload batch')
    }

    const snapshots: VaultSnapshotInput[] = rawSnapshots.map((s): VaultSnapshotInput => {
      if ('snapshotCursor' in s) {
        return s
      }
      return s.snapshot
    })

    const response = await apiClient.putSnapshots(
      {
        account: accountId,
        snapshots,
      },
      signal ? { signal } : undefined
    )

    if (
      !response?.success ||
      (response.persisted !== undefined && response.persisted !== snapshots.length)
    ) {
      throw new Error(
        `Upload unconfirmed: response success=${response?.success}, persisted=${response?.persisted}/${snapshots.length}`
      )
    }
  }

  /**
   * Stage 2c (pure operation): Report progress.
   */
  reportProgress(
    done: number,
    total: number,
    onProgress?: (done: number, total: number) => void
  ): void {
    const callback = onProgress ?? this.activeProgressCallback ?? this.activeContext?.onProgress
    if (callback) {
      callback(Math.min(done, total), total)
    }
  }

  private async buildSnapshotWithRetry(
    repo: Repo,
    itemId: ItemId,
    signal?: AbortSignal,
    batchRetryDelays?: readonly number[]
  ): Promise<BuildSnapshotResult> {
    return await RetryStrategy.executeWithRetry(
      async () => this.buildSnapshot(itemId, repo),
      {
        maxAttempts: MAX_BATCH_RETRIES,
        delays: batchRetryDelays ?? this.batchRetryDelays,
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

  private async uploadBatchWithRetry(
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
            await this.uploadBatch(apiClient, accountId, readySnapshots, signal)
            return { uploadSuccess: true, lastError: null }
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
          delays: batchRetryDelays ?? this.batchRetryDelays,
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

  /**
   * Stage 2 (orchestrator): Process a single chunk of items with error handling and retry logic.
   */
  async processChunk(
    chunk: ItemId[],
    signalOrContext?: AbortSignal | ProcessChunkContext,
    contextOrSignal?: ProcessChunkContext | AbortSignal
  ): Promise<ReencryptResult> {
    let signal: AbortSignal | undefined
    let context: ProcessChunkContext | undefined

    if (signalOrContext instanceof AbortSignal || (signalOrContext && 'aborted' in signalOrContext)) {
      signal = signalOrContext as AbortSignal
      context = contextOrSignal as ProcessChunkContext | undefined
    } else if (signalOrContext && typeof signalOrContext === 'object' && !('aborted' in signalOrContext)) {
      context = signalOrContext as ProcessChunkContext
      signal = contextOrSignal as AbortSignal | undefined
    } else if (contextOrSignal && typeof contextOrSignal === 'object' && !('aborted' in contextOrSignal)) {
      context = contextOrSignal as ProcessChunkContext
    }

    const ctx = context ?? this.activeContext
    if (!ctx) {
      throw new Error('SyncWorker not initialized')
    }
    signal = signal ?? ctx.deps?.signal

    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new AbortError(typeof signal.reason === 'string' ? signal.reason : 'Re-encryption aborted')
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const errMsg = 'Network is offline'
      console.warn(`[reencryptAllItems] Aborting: ${errMsg}`)
      if (ctx.deps) {
        this.scheduleRetry(ctx.deps, ctx.onProgress)
      }
      throw new Error(`Re-encryption aborted: network error (${errMsg})`)
    }

    await ctx.apiClient.syncLatestToken()

    const batchRetryDelays = ctx.batchRetryDelays ?? this.batchRetryDelays
    const settled = await Promise.allSettled(
      chunk.map(itemId =>
        this.buildSnapshotWithRetry(ctx.repo, itemId, signal, batchRetryDelays)
      )
    )

    const readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }> = []
    const failureDetails: Array<{ itemId: ItemId; errorMsg: string; rawError?: unknown }> = []

    for (const [index, result] of settled.entries()) {
      const itemId = chunk[index]
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

    const succeeded: ItemId[] = []
    const failed: Array<{ itemId: ItemId; error: string }> = []

    for (const failure of failureDetails) {
      if (failure.rawError !== undefined) {
        console.error(`[reencryptAllItems] ${failure.errorMsg}`, failure.rawError)
      } else {
        console.error(`[reencryptAllItems] ${failure.errorMsg}`)
      }
      failed.push({ itemId: failure.itemId, error: failure.errorMsg })
      await this.quarantineItem(
        failure.itemId,
        `Re-encryption snapshot build failed: ${failure.errorMsg}`,
        ctx.recoveryManager
      )
    }

    if (readySnapshots.length > 0) {
      const snapshotBatches = SizeAwareBatchAccumulator.batch(readySnapshots, {
        maxBatchCount: this.maxBatchCount,
        maxBatchBytes: this.maxBatchBytes,
        calculateSize: item => estimateSnapshotSize(item.snapshot),
      })

      for (const batch of snapshotBatches) {
        const { uploadSuccess, lastError } = await this.uploadBatchWithRetry(
          ctx.apiClient,
          ctx.accountId,
          batch,
          signal,
          batchRetryDelays
        )

        if (uploadSuccess) {
          for (const item of batch) {
            succeeded.push(item.itemId)
          }
        } else {
          const errMsg = this.handleBatchUploadFailure(
            lastError,
            ctx.deps ?? { accountId: ctx.accountId, repo: ctx.repo, indexManager: null as any },
            ctx.onProgress
          )
          console.error(`[reencryptAllItems] ${errMsg}`)
          for (const item of batch) {
            failed.push({ itemId: item.itemId, error: errMsg })
            await this.quarantineItem(
              item.itemId,
              `Re-encryption upload failed: ${errMsg}`,
              ctx.recoveryManager
            )
          }
        }
      }
    }

    if (ctx.total !== undefined) {
      ctx.processedCount = (ctx.processedCount ?? 0) + chunk.length
      this.reportProgress(ctx.processedCount, ctx.total, ctx.onProgress)
    }

    return { succeeded, failed }
  }

  /**
   * Main entry point to reencrypt all items across all chunks.
   */
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
      this.reportProgress(0, 0, onProgress)
      this.retryStrategy.reset()
      return { succeeded: [], failed: [] }
    }

    const succeeded: ItemId[] = []
    const failed: Array<{ itemId: ItemId; error: string }> = []

    const itemChunks = this.buildReencryptionPlan(allItemIds, REENCRYPT_CHUNK_SIZE)
    const batchRetryDelays = deps.batchRetryDelays ?? this.batchRetryDelays

    const context: ProcessChunkContext = {
      accountId,
      repo,
      apiClient,
      recoveryManager,
      batchRetryDelays,
      deps,
      onProgress,
      total,
      processedCount: 0,
    }

    this.activeContext = context
    this.activeProgressCallback = onProgress

    try {
      for (const chunkIds of itemChunks) {
        const chunkResult = await this.processChunk(chunkIds, deps.signal, context)
        succeeded.push(...chunkResult.succeeded)
        failed.push(...chunkResult.failed)
      }

      this.retryStrategy.reset()
      return { succeeded, failed }
    } finally {
      this.activeContext = undefined
      this.activeProgressCallback = undefined
    }
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
