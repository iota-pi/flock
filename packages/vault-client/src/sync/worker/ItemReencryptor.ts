import { chunk, partition } from 'lodash-es'

import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { estimateSnapshotSize, type BuildSnapshotResult, type SnapshotBuilder } from './snapshotBuilder'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { uploadSnapshotBatch, type StoredSnapshotRecorder } from './snapshotUpload'
import { classifySyncError } from '../utils/errorClassifier'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { RetryTimer } from '../utils/RetryTimer'
import { checkAlive, isAbortError, untilAborted } from '../utils/abort'
import { errorMessage } from '../utils/errorMessage'
import {
  SizeAwareBatchAccumulator,
  DEFAULT_MAX_BATCH_BYTES,
} from '../utils/SizeAwareBatchAccumulator'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { fireAndForget } from '../utils/fireAndForget'
import type { ItemId, VaultSnapshotInput } from '@vault/shared'
import type { ReencryptResult } from '../shared/types'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('ItemReencryptor')

const MAX_BATCH_RETRIES = 3
const DEFAULT_BATCH_RETRY_DELAYS = [0, 0, 0] as const
const REENCRYPT_CHUNK_SIZE = SYNC_BATCH_SIZES.reencryptChunk

type FailedItem = ReencryptResult['failed'][number]
type ReadySnapshot = { itemId: ItemId; snapshot: VaultSnapshotInput; heads?: string[] }

/** One call's options for `ItemReencryptor.run`. A scheduled retry runs with the same ones. */
export interface ReencryptRunOptions {
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface ItemReencryptorOptions {
  accountId: string
  builder: SnapshotBuilder
  indexManager: AutomergeIndexManager
  apiClient: SyncApiClient
  recoveryManager: RecoveryManager
  /** Uploads stop while the session is offline */
  session: SyncSessionState
  retryDelays?: number[]
  batchRetryDelays?: readonly number[]
  maxBatchCount?: number
  maxBatchBytes?: number
  /**
   * Records the snapshots the server stored, as the snapshot pusher does. Otherwise the next manifest
   * sync would take the new versions for remote changes and fetch every item.
   */
  recorder?: StoredSnapshotRecorder
}

export class ItemReencryptor {
  private readonly accountId: string
  private readonly builder: SnapshotBuilder
  private readonly indexManager: AutomergeIndexManager
  private readonly apiClient: SyncApiClient
  private readonly recoveryManager: RecoveryManager
  private readonly session: SyncSessionState
  private readonly retryStrategy: RetryStrategy
  private readonly retryTimer = new RetryTimer()
  private readonly maxBatchCount: number
  private readonly maxBatchBytes: number
  private readonly batchRetryDelays: readonly number[]
  private readonly reencryptGuard = new SingleFlightGuard<ReencryptResult>()
  private readonly progressCallbacks = new Set<(done: number, total: number) => void>()
  private readonly recorder?: StoredSnapshotRecorder

  constructor(options: ItemReencryptorOptions) {
    this.accountId = options.accountId
    this.builder = options.builder
    this.indexManager = options.indexManager
    this.apiClient = options.apiClient
    this.recoveryManager = options.recoveryManager
    this.session = options.session
    this.recorder = options.recorder
    this.retryStrategy = new RetryStrategy({ delays: options.retryDelays ?? DEFAULT_RETRY_DELAYS })
    this.batchRetryDelays = options.batchRetryDelays ?? DEFAULT_BATCH_RETRY_DELAYS
    this.maxBatchCount = options.maxBatchCount ?? REENCRYPT_CHUNK_SIZE
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  }

  get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  cancelScheduled(): void {
    this.retryTimer.cancel()
    this.retryStrategy.reset()
  }

  /** Schedules another run with the same options after the next backoff delay, which it returns */
  scheduleRetry(options: ReencryptRunOptions = {}): number {
    const delayMs = this.retryStrategy.nextDelay()

    log.warn(
      `Scheduling re-encryption retry (attempt ${this.retryStrategy.attempt}) in ${delayMs}ms`
    )

    this.retryTimer.schedule(delayMs, () => {
      fireAndForget(
        this.run(options),
        'ItemReencryptor:scheduledRetry',
        err => {
          log.warn('Scheduled retry failed:', err)
        },
      )
    })

    return delayMs
  }

  /**
   * Re-encrypts every item. Concurrent calls share one run, and each caller's signal only stops that
   * caller waiting for it.
   */
  async run(options: ReencryptRunOptions = {}): Promise<ReencryptResult> {
    const { onProgress, signal } = options
    checkAlive(signal, true, 'Re-encryption aborted')

    this.retryTimer.cancel()

    if (onProgress) {
      this.progressCallbacks.add(onProgress)
    }

    const runPromise = this.reencryptGuard.run(() => this.runAll(options))

    try {
      return await (signal ? untilAborted(runPromise, signal) : runPromise)
    } finally {
      if (onProgress) {
        this.progressCallbacks.delete(onProgress)
      }
    }
  }

  private async runAll(options: ReencryptRunOptions): Promise<ReencryptResult> {
    const initialToken = await this.apiClient.getValidToken()
    if (!initialToken) {
      throw new Error('No active session token available')
    }

    const allItemIds = await this.indexManager.listItemIds()
    const total = allItemIds.length
    const result: ReencryptResult = { succeeded: [], failed: [] }

    if (total === 0) {
      this.reportProgress(0, 0)
    }

    try {
      let done = 0
      for (const itemIds of chunk(allItemIds, REENCRYPT_CHUNK_SIZE)) {
        await this.processChunk(itemIds, result, options.signal)
        done += itemIds.length
        this.reportProgress(done, total)
      }
    } catch (err) {
      if (!isAbortError(err)) {
        const classified = classifySyncError(err)
        if (classified.isNetwork || classified.isServerError) {
          this.scheduleRetry(options)
        }
      }
      throw err
    }

    this.retryStrategy.reset()
    return result
  }

  /** Builds and uploads one chunk's snapshots, adding each item to `result` */
  private async processChunk(
    itemIds: ItemId[],
    result: ReencryptResult,
    signal?: AbortSignal
  ): Promise<void> {
    checkAlive(signal, true, 'Re-encryption aborted')

    if (!this.session.isOnline) {
      const errMsg = 'Network is offline'
      log.warn(`Aborting: ${errMsg}`)
      throw new Error(`Re-encryption aborted: network error (${errMsg})`)
    }

    const settled = await Promise.allSettled(
      itemIds.map(itemId => this.buildSnapshotWithRetry(itemId, signal))
    )

    const readySnapshots: ReadySnapshot[] = []
    const buildFailures: FailedItem[] = []

    for (const [index, outcome] of settled.entries()) {
      const itemId = itemIds[index]
      if (outcome.status === 'rejected') {
        if (signal?.aborted || isAbortError(outcome.reason)) {
          throw outcome.reason
        }
        const error = `Failed to build snapshot for item ${itemId}: ${errorMessage(outcome.reason)}`
        log.error(error, outcome.reason)
        buildFailures.push({ itemId, error })
      } else if (outcome.value.type === 'success') {
        readySnapshots.push({ itemId, snapshot: outcome.value.snapshot, heads: outcome.value.heads })
      } else {
        const error = outcome.value.reason
          ? `Failed to build snapshot for item ${itemId}: ${outcome.value.reason}`
          : `Failed to build snapshot for item ${itemId}`
        log.error(error)
        buildFailures.push({ itemId, error })
      }
    }

    await this.recordFailures(buildFailures, 'Re-encryption snapshot build failed', result)

    const snapshotBatches = SizeAwareBatchAccumulator.batch(readySnapshots, {
      maxBatchCount: this.maxBatchCount,
      maxBatchBytes: this.maxBatchBytes,
      calculateSize: item => estimateSnapshotSize(item.snapshot),
    })

    for (const batch of snapshotBatches) {
      const storedIds = new Set<ItemId>()
      try {
        await this.uploadBatchWithRetry(batch, storedIds, signal)
      } catch (err) {
        const error = this.describeUploadFailure(err, signal)
        log.error(error)
        // The server holds the re-encrypted snapshots an earlier attempt stored
        const [stored, unstored] = partition(batch, item => storedIds.has(item.itemId))
        result.succeeded.push(...stored.map(item => item.itemId))
        await this.recordFailures(
          unstored.map(({ itemId }) => ({ itemId, error })),
          'Re-encryption upload failed',
          result
        )
        continue
      }
      result.succeeded.push(...batch.map(item => item.itemId))
    }
  }

  private buildSnapshotWithRetry(
    itemId: ItemId,
    signal?: AbortSignal
  ): Promise<Exclude<BuildSnapshotResult, { type: 'not-ready' }>> {
    return RetryStrategy.executeWithRetry(
      async () => {
        const result = await this.builder.build(itemId, 0, { signal })
        if (result.type === 'not-ready') {
          throw new Error(`Item ${itemId} document or vault was not ready`)
        }
        return result
      },
      {
        maxAttempts: MAX_BATCH_RETRIES,
        delays: this.batchRetryDelays,
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

  /**
   * Uploads a batch, retrying unless it's an auth error or the device has gone offline. Each attempt
   * resends the whole batch and adds the items the server stored to `storedIds`.
   */
  private uploadBatchWithRetry(
    batch: ReadySnapshot[],
    storedIds: Set<ItemId>,
    signal?: AbortSignal
  ): Promise<void> {
    return RetryStrategy.executeWithRetry(
      async () => {
        const result = await uploadSnapshotBatch(batch, {
          accountId: this.accountId,
          apiClient: this.apiClient,
          recorder: this.recorder,
          signal,
        })
        for (const item of result.stored) {
          storedIds.add(item.itemId)
        }
        if (!result.success) {
          throw new Error(
            `Upload unconfirmed: the server stored ${result.persisted}/${batch.length} snapshots`
          )
        }
      },
      {
        maxAttempts: MAX_BATCH_RETRIES,
        delays: this.batchRetryDelays,
        signal,
        shouldRetry: err => {
          const classified = classifySyncError(err)
          if (classified.isAuth) return false
          return this.session.isOnline || !(classified.isNetwork || classified.isServerError)
        },
        onRetry: (err, attempt) => {
          log.warn(`Attempt ${attempt} failed to upload snapshots for batch:`, err)
        },
      }
    )
  }

  /**
   * Rethrows an upload error that should stop the whole run (an abort, an auth error, or a network or
   * server error), and otherwise describes the permanent failure the batch's items are quarantined for.
   * `SyncApiClient` has already turned auth errors it couldn't recover from into `AuthExpiredError`.
   */
  private describeUploadFailure(err: unknown, signal?: AbortSignal): string {
    checkAlive(signal, true, 'Re-encryption aborted')
    const classified = classifySyncError(err)
    if (isAbortError(err) || classified.isAuth) {
      throw err
    }

    if (classified.isNetwork || classified.isServerError) {
      const errMsg = classified.message || errorMessage(err)
      const errorType = classified.isServerError ? 'server error' : 'network error'
      log.warn(
        `Transient ${errorType} during upload: ${errMsg}. Aborting operation.`
      )
      throw new Error(
        `Re-encryption aborted: ${errorType} (${errMsg})`,
        { cause: err }
      )
    }

    return (
      `Failed to upload snapshots for batch after ${MAX_BATCH_RETRIES} attempts` +
      (err instanceof Error ? `: ${err.message}` : '')
    )
  }

  /** Adds failed items to `result` and quarantines them for manual recovery */
  private async recordFailures(
    failures: FailedItem[],
    stage: string,
    result: ReencryptResult
  ): Promise<void> {
    for (const failure of failures) {
      result.failed.push(failure)
      try {
        await this.recoveryManager.quarantine(failure.itemId, 'snapshotFailure', `${stage}: ${failure.error}`)
      } catch (storageErr) {
        log.error(`Failed to quarantine item ${failure.itemId}:`, storageErr)
      }
    }
  }

  /** Reports progress to every caller waiting on the run */
  private reportProgress(done: number, total: number): void {
    for (const cb of this.progressCallbacks) {
      try {
        cb(Math.min(done, total), total)
      } catch {
        // Ignore
      }
    }
  }
}
