import type { Repo } from '@automerge/automerge-repo/slim'
import { chunk } from 'lodash-es'

import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { buildSnapshot as buildSnapshotFromBuilder, type BuildSnapshotResult } from './snapshotBuilder'
import type { DocCodec } from './domain'
import { RecoveryManager } from './RecoveryManager'
import { SyncApiClient, toAuthExpiredError } from './SyncApiClient'
import { classifySyncError } from './utils/errorClassifier'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { AbortError, isAbortError } from '../utils/abort'
import {
  SizeAwareBatchAccumulator,
  DEFAULT_MAX_BATCH_BYTES,
} from '../utils/SizeAwareBatchAccumulator'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { estimateSnapshotSize } from './SnapshotBatchAccumulator'
import { fireAndForget } from '../utils/fireAndForget'
import { getOnlineState } from '../utils/onlineStatus'
import type { ItemId, PutSnapshotResultItem, VaultSnapshotInput } from '@vault/shared'
import type { ReencryptResult } from './syncProtocol'
import { SYNC_BATCH_SIZES } from '../syncConfig'
import type { KeyProvider } from '../../api/Keyring'
import { createLogger } from '../utils/logger'

const log = createLogger('reencryptAllItems')

const MAX_BATCH_RETRIES = 3
const DEFAULT_BATCH_RETRY_DELAYS = [0, 0, 0] as const
const REENCRYPT_CHUNK_SIZE = SYNC_BATCH_SIZES.reencryptChunk

async function quarantineItem(
  recoveryManager: RecoveryManager,
  itemId: ItemId,
  reason: string
): Promise<void> {
  try {
    await recoveryManager.quarantine(itemId, 'snapshotFailure', reason)
  } catch (storageErr) {
    log.error(`Failed to quarantine item ${itemId}:`, storageErr)
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

export interface ProcessChunkContext {
  accountId: string
  repo: Repo
  apiClient: SyncApiClient
  recoveryManager: RecoveryManager
  signal?: AbortSignal
  batchRetryDelays?: readonly number[]
  onProgress?: (done: number, total: number) => void
  total?: number
  processedCount?: number
}

/** A snapshot the server has stored, with the version it assigned and the heads it holds */
export interface StoredSnapshot {
  itemId: ItemId
  version?: number
  heads?: string[]
}

export interface ItemReencryptorOptions {
  retryDelays?: number[]
  batchRetryDelays?: readonly number[]
  maxBatchCount?: number
  maxBatchBytes?: number
  codec?: DocCodec
  keys: KeyProvider
  /**
   * Called with each batch the server stored, so the sync engine can record the new versions and
   * heads. Otherwise the next manifest sync would take them for remote changes and fetch every item.
   */
  onSnapshotsStored?: (stored: StoredSnapshot[]) => Promise<void> | void
}

export class ItemReencryptor {
  private readonly retryStrategy: RetryStrategy
  private scheduledRetryTimeoutId: ReturnType<typeof setTimeout> | null = null
  public readonly maxBatchCount: number
  public readonly maxBatchBytes: number
  public readonly batchRetryDelays: readonly number[]
  private readonly reencryptGuard = new SingleFlightGuard<ReencryptResult>()
  private readonly progressCallbacks = new Set<(done: number, total: number) => void>()
  private readonly codec?: DocCodec
  private readonly keys: KeyProvider
  private readonly onSnapshotsStored?: ItemReencryptorOptions['onSnapshotsStored']

  constructor(options: ItemReencryptorOptions) {
    this.codec = options.codec
    this.keys = options.keys
    this.onSnapshotsStored = options.onSnapshotsStored
    this.retryStrategy = new RetryStrategy({ delays: options.retryDelays ?? DEFAULT_RETRY_DELAYS })
    this.batchRetryDelays = options.batchRetryDelays ?? DEFAULT_BATCH_RETRY_DELAYS
    this.maxBatchCount = options.maxBatchCount ?? REENCRYPT_CHUNK_SIZE
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  }

  get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  get isReencrypting(): boolean {
    return this.reencryptGuard.isRunning
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

    log.warn(
      `Scheduling re-encryption retry (attempt ${this.retryStrategy.attempt}) in ${delayMs}ms`
    )

    if (deps.scheduleRetry) {
      deps.scheduleRetry(delayMs)
    } else {
      if (this.scheduledRetryTimeoutId !== null) {
        clearTimeout(this.scheduledRetryTimeoutId)
      }
      this.scheduledRetryTimeoutId = setTimeout(() => {
        this.scheduledRetryTimeoutId = null
        fireAndForget(
          this.reencryptAllItems(deps, onProgress),
          'reencryptAllItems:scheduledRetry',
          err => {
            log.warn('Scheduled retry failed:', err)
          },
        )
      }, delayMs)
    }

    return delayMs
  }

  handleBatchUploadFailure(lastError: unknown): string {
    const classified = classifySyncError(lastError)
    if (classified.isAuth) {
      throw toAuthExpiredError(lastError)
    }

    if (classified.isNetwork || classified.isServerError) {
      const errMsg = classified.message || (lastError instanceof Error ? lastError.message : String(lastError))
      const errorType = classified.isServerError ? 'server error' : 'network error'
      log.warn(
        `Transient ${errorType} during upload: ${errMsg}. Aborting operation.`
      )
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
    const manager = recoveryManager
    if (!manager) {
      log.error(`Failed to quarantine item ${itemId}: No RecoveryManager available`)
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
  async buildSnapshot(itemId: ItemId, repo: Repo, signal?: AbortSignal): Promise<BuildSnapshotResult> {
    return buildSnapshotFromBuilder(repo, itemId, 0, this.keys, { signal, codec: this.codec })
  }

  /**
   * Stage 2b (pure operation): Upload batch of snapshots.
   */
  async uploadBatch(
    apiClient: SyncApiClient,
    accountId: string,
    batch: ReadonlyArray<{ snapshot: VaultSnapshotInput }>,
    signal?: AbortSignal
  ): Promise<PutSnapshotResultItem[]> {
    const snapshots = batch.map(item => item.snapshot)
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
    return response.results ?? []
  }

  private async reportStored(
    batch: Array<{ itemId: ItemId; heads?: string[] }>,
    results?: PutSnapshotResultItem[],
  ): Promise<void> {
    if (!this.onSnapshotsStored) return
    const versions = new Map((results ?? []).map(r => [r.itemId, r.version]))
    try {
      await this.onSnapshotsStored(batch.map(item => ({
        itemId: item.itemId,
        version: versions.get(item.itemId),
        heads: item.heads,
      })))
    } catch (err) {
      // The snapshots are stored either way; the next manifest sync just fetches them again
      log.warn('Failed to record uploaded snapshots:', err)
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
    const clampedDone = Math.min(done, total)
    if (onProgress) {
      try {
        onProgress(clampedDone, total)
      } catch {
        // Ignore
      }
    }
    for (const cb of this.progressCallbacks) {
      if (cb !== onProgress) {
        try {
          cb(clampedDone, total)
        } catch {
          // Ignore
        }
      }
    }
  }

  private async buildSnapshotWithRetry(
    repo: Repo,
    itemId: ItemId,
    signal?: AbortSignal,
    batchRetryDelays?: readonly number[]
  ): Promise<BuildSnapshotResult> {
    return await RetryStrategy.executeWithRetry(
      async () => {
        const result = await this.buildSnapshot(itemId, repo, signal)
        if (result.type === 'not-ready') {
          throw new Error(`Item ${itemId} document or vault was not ready`)
        }
        return result
      },
      {
        maxAttempts: MAX_BATCH_RETRIES,
        delays: batchRetryDelays ?? this.batchRetryDelays,
        signal,
        onRetry: (err, attempt) => {
          log.warn(
            `Retry ${attempt}/${MAX_BATCH_RETRIES} building snapshot for ${itemId}:`,
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
  ): Promise<{ uploadSuccess: boolean; lastError: unknown; results?: PutSnapshotResultItem[] }> {
    try {
      return await RetryStrategy.executeWithRetry(
        async attempt => {
          try {
            const results = await this.uploadBatch(apiClient, accountId, readySnapshots, signal)
            return { uploadSuccess: true, lastError: null, results }
          } catch (err) {
            log.warn(
              `Attempt ${attempt} failed to upload snapshots for batch:`,
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
              if (!getOnlineState()) {
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
  async processChunk(chunk: ItemId[], ctx: ProcessChunkContext): Promise<ReencryptResult> {
    const signal = ctx.signal
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new AbortError(typeof signal.reason === 'string' ? signal.reason : 'Re-encryption aborted')
    }

    if (!getOnlineState()) {
      const errMsg = 'Network is offline'
      log.warn(`Aborting: ${errMsg}`)
      throw new Error(`Re-encryption aborted: network error (${errMsg})`)
    }

    await ctx.apiClient.syncLatestToken()

    const batchRetryDelays = ctx.batchRetryDelays ?? this.batchRetryDelays
    const settled = await Promise.allSettled(
      chunk.map(itemId =>
        this.buildSnapshotWithRetry(ctx.repo, itemId, signal, batchRetryDelays)
      )
    )

    const readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput; heads?: string[] }> = []
    const failureDetails: Array<{ itemId: ItemId; errorMsg: string; rawError?: unknown }> = []

    for (const [index, result] of settled.entries()) {
      const itemId = chunk[index]
      if (result.status === 'fulfilled') {
        if (result.value.type === 'success') {
          readySnapshots.push({ itemId, snapshot: result.value.snapshot, heads: result.value.heads })
        } else if (result.value.type === 'not-ready') {
          const errorMsg = `Failed to build snapshot for item ${itemId}: Document or vault was not ready after retries`
          log.error(`${errorMsg}`)
          failureDetails.push({ itemId, errorMsg })
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
        log.error(`${failure.errorMsg}`, failure.rawError)
      } else {
        log.error(`${failure.errorMsg}`)
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
        const { uploadSuccess, lastError, results } = await this.uploadBatchWithRetry(
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
          await this.reportStored(batch, results)
        } else {
          const errMsg = this.handleBatchUploadFailure(lastError)
          log.error(`${errMsg}`)
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

    if (deps.signal?.aborted) {
      throw deps.signal.reason instanceof Error
        ? deps.signal.reason
        : new AbortError(typeof deps.signal.reason === 'string' ? deps.signal.reason : 'Re-encryption aborted')
    }

    if (this.scheduledRetryTimeoutId !== null) {
      clearTimeout(this.scheduledRetryTimeoutId)
      this.scheduledRetryTimeoutId = null
    }

    if (onProgress) {
      this.progressCallbacks.add(onProgress)
    }

    const runPromise = this.reencryptGuard.run(async () => {
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
        signal: deps.signal,
        batchRetryDelays,
        onProgress,
        total,
        processedCount: 0,
      }

      try {
        for (const chunkIds of itemChunks) {
          const chunkResult = await this.processChunk(chunkIds, context)
          succeeded.push(...chunkResult.succeeded)
          failed.push(...chunkResult.failed)
        }

        this.retryStrategy.reset()
        return { succeeded, failed }
      } catch (err) {
        if (!isAbortError(err)) {
          const classified = classifySyncError(err)
          if (classified.isNetwork || classified.isServerError) {
            this.scheduleRetry(deps, onProgress)
          }
        }
        throw err
      }
    })

    try {
      if (!deps.signal) {
        return await runPromise
      }

      const signal = deps.signal
      return await new Promise<ReencryptResult>((resolve, reject) => {
        const onAbort = () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new AbortError(typeof signal.reason === 'string' ? signal.reason : 'Re-encryption aborted')
          )
        }
        signal.addEventListener('abort', onAbort, { once: true })
        runPromise
          .then(resolve, reject)
          .finally(() => {
            signal.removeEventListener('abort', onAbort)
          })
      })
    } finally {
      if (onProgress) {
        this.progressCallbacks.delete(onProgress)
      }
    }
  }
}
