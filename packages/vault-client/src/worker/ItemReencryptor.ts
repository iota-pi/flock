import { chunk, partition } from 'lodash-es'

import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { estimateSnapshotSize, type BuildSnapshotResult, type SnapshotBuilder } from './SnapshotBuilder'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { uploadSnapshotBatch, type StoredSnapshotRecorder, type UploadableSnapshot } from './snapshotUpload'
import { classifySyncError } from '../utils/errorClassifier'
import { isClientOutdatedError } from '@vault/shared'
import type { FirstStart } from './FirstStart'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { RetryTimer } from '../utils/RetryTimer'
import { AbortError, checkAlive, isAbortError, untilAborted, withTimeout } from '../utils/abort'
import { errorMessage } from '../utils/errorMessage'
import {
  SizeAwareBatchAccumulator,
  DEFAULT_MAX_BATCH_BYTES,
} from '../utils/SizeAwareBatchAccumulator'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { fireAndForget } from '../utils/fireAndForget'
import type { ItemId } from '@vault/shared'
import type { ReencryptOptions, ReencryptResult, ReencryptStage } from '../shared/types'
import { ReencryptionWaitError } from '../shared/reencryptionWaitError'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('ItemReencryptor')

const MAX_BATCH_RETRIES = 3
const DEFAULT_BATCH_RETRY_DELAYS = [0, 0, 0] as const
const REENCRYPT_CHUNK_SIZE = SYNC_BATCH_SIZES.reencryptChunk

type FailedItem = ReencryptResult['failed'][number]

/** An item that can't have a snapshot yet. It isn't broken, so a later run can retry it. */
class DeferredBuildError extends Error {
  constructor(itemId: ItemId, readonly canRetry: boolean) {
    super(`The snapshot of item ${itemId} has to wait for the log`)
    this.name = 'DeferredBuildError'
  }
}

/** One call's options for `ItemReencryptor.run`. A scheduled retry runs with the same ones. */
export interface ReencryptRunOptions extends ReencryptOptions {
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

export interface ItemReencryptorOptions {
  accountId: string
  builder: SnapshotBuilder
  indexManager: AutomergeIndexManager
  apiClient: SyncApiClient
  recoveryManager: RecoveryManager
  /** Uploads stop while the session is offline, and only the leader pushes */
  session: SyncSessionState
  /** Makes this tab the leader, which pushes */
  claimLeader: () => void
  firstStart: Pick<FirstStart, 'canPush' | 'whenReadyToPush'>
  /** Called whenever the run's stage changes, and with null once it stops */
  onStage?: (stage: ReencryptStage | null) => void
  /** Pushes items' changes to the log, which comes before their snapshots */
  pushToLog: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
  retryDelays?: number[]
  batchRetryDelays?: readonly number[]
  maxBatchBytes?: number
  /**
   * Records the snapshots the server stored, as the snapshot pusher does. Otherwise the next manifest
   * sync would take the new versions for remote changes and fetch every item.
   */
  recorder?: StoredSnapshotRecorder
}

export class ItemReencryptor {
  private readonly retryStrategy: RetryStrategy
  private readonly retryTimer = new RetryTimer()
  private readonly maxBatchBytes: number
  private readonly batchRetryDelays: readonly number[]
  private readonly reencryptGuard = new SingleFlightGuard<ReencryptResult>()
  private readonly progressCallbacks = new Set<(done: number, total: number) => void>()
  /** One for the run in flight and one for each `prepare` waiting, which `cancel` aborts */
  private readonly cancellers = new Set<AbortController>()
  private isRunning = false
  private currentStage: ReencryptStage | null = null

  constructor(private readonly deps: ItemReencryptorOptions) {
    this.retryStrategy = new RetryStrategy({ delays: deps.retryDelays ?? DEFAULT_RETRY_DELAYS })
    this.batchRetryDelays = deps.batchRetryDelays ?? DEFAULT_BATCH_RETRY_DELAYS
    this.maxBatchBytes = deps.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  }

  get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  /** What the run in flight is doing, or null when none is */
  get stage(): ReencryptStage | null {
    return this.currentStage
  }

  /**
   * Stops the run in flight and any scheduled retry. A run that was waiting has changed nothing, and
   * one that was rewriting stops between chunks, leaving the rest for the next run.
   */
  cancel(): void {
    this.cancelScheduled()
    for (const canceller of this.cancellers) {
      canceller.abort(new AbortError('Re-encryption cancelled'))
    }
  }

  /**
   * Waits until a run could push, as `run` does first, without rewriting anything. A caller that has
   * to change something before the rewrite (such as rotating the key) calls this first, so that a
   * device that can't push stops before that change.
   */
  async prepare(options: ReencryptOptions & { signal?: AbortSignal } = {}): Promise<void> {
    await this.withCanceller(options.signal, async signal => {
      try {
        await this.waitUntilPushesCanRun(signal, options.waitTimeoutMs)
      } finally {
        if (!this.isRunning) this.setStage(null)
      }
    })
  }

  private async withCanceller<T>(outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const canceller = new AbortController()
    this.cancellers.add(canceller)
    try {
      return await fn(outer ? AbortSignal.any([outer, canceller.signal]) : canceller.signal)
    } finally {
      this.cancellers.delete(canceller)
    }
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
    this.isRunning = true
    try {
      return await this.withCanceller(options.signal, signal => this.runAllWith({ ...options, signal }))
    } finally {
      this.isRunning = false
      this.setStage(null)
    }
  }

  private async runAllWith(options: ReencryptRunOptions): Promise<ReencryptResult> {
    const initialToken = await this.deps.apiClient.getValidToken()
    if (!initialToken) {
      throw new Error('No active session token available')
    }

    await this.waitUntilPushesCanRun(options.signal, options.waitTimeoutMs)
    this.setStage('reencrypting')

    const allItemIds = await this.deps.indexManager.listItemIds()
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

  /**
   * A rewrite pushes first, so it runs on the leader, once first start allows pushes. It doesn't wait
   * for first start's own push to finish, or for every first-start record to clear: one item the
   * server keeps refusing, or one missing key, would stall it for good. Each chunk pushes its own
   * items, and S1 defers any it couldn't. Offline there's nothing to wait for: the first chunk stops
   * the run. With `timeoutMs`, each wait gives up with a `ReencryptionWaitError`.
   */
  private async waitUntilPushesCanRun(signal?: AbortSignal, timeoutMs?: number): Promise<void> {
    if (!this.deps.session.isOnline) return
    if (!this.deps.session.isLeader) {
      this.setStage('waitingForLeader')
      this.deps.claimLeader()
      await this.waitFor('waitingForLeader', waitSignal => this.deps.session.whenLeader(waitSignal), signal, timeoutMs)
    }
    if (!this.deps.firstStart.canPush) {
      this.setStage('waitingForSync')
      await this.waitFor('waitingForSync', waitSignal => this.deps.firstStart.whenReadyToPush(waitSignal), signal, timeoutMs)
    }
  }

  private async waitFor(
    stage: Exclude<ReencryptStage, 'reencrypting'>,
    wait: (signal?: AbortSignal) => Promise<void>,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<void> {
    if (timeoutMs === undefined) {
      await wait(signal)
      return
    }
    try {
      await withTimeout(timeoutMs, wait, { signal })
    } catch (error) {
      // Only the timeout aborts without the caller's signal
      if (!signal?.aborted && isAbortError(error)) {
        throw new ReencryptionWaitError(stage)
      }
      throw error
    }
  }

  private setStage(stage: ReencryptStage | null): void {
    if (this.currentStage === stage) return
    this.currentStage = stage
    try {
      this.deps.onStage?.(stage)
    } catch {
      // Ignore
    }
  }

  /** Builds and uploads one chunk's snapshots, adding each item to `result` */
  private async processChunk(
    itemIds: ItemId[],
    result: ReencryptResult,
    signal?: AbortSignal
  ): Promise<void> {
    checkAlive(signal, true, 'Re-encryption aborted')

    if (!this.deps.session.isOnline) {
      log.warn('Aborting: network is offline')
      throw new Error('Re-encryption aborted: network error (offline)')
    }

    await this.deps.pushToLog(itemIds, signal)

    const settled = await Promise.allSettled(
      itemIds.map(itemId => this.buildSnapshotWithRetry(itemId, signal))
    )

    const readySnapshots: UploadableSnapshot[] = []
    const buildFailures: FailedItem[] = []

    for (const [index, outcome] of settled.entries()) {
      const itemId = itemIds[index]
      if (outcome.status === 'rejected') {
        if (signal?.aborted || isAbortError(outcome.reason)) {
          throw outcome.reason
        }
        if (outcome.reason instanceof DeferredBuildError) {
          log.warn(outcome.reason.message)
          result.failed.push({ itemId, error: outcome.reason.message })
          continue
        }
        const classified = classifySyncError(outcome.reason)
        if (classified.isNetwork || classified.isServerError || classified.isAuth) {
          throw outcome.reason
        }
        const error = `Failed to build snapshot for item ${itemId}: ${errorMessage(outcome.reason)}`
        log.error(error, outcome.reason)
        buildFailures.push({ itemId, error })
      } else if (outcome.value.type === 'success') {
        readySnapshots.push({ snapshot: outcome.value.snapshot, heads: outcome.value.heads })
      } else {
        const error = outcome.value.reason
          ? `Failed to build snapshot for item ${itemId}: ${outcome.value.reason}`
          : `Failed to build snapshot for item ${itemId}`
        log.error(error)
        buildFailures.push({ itemId, error })
      }
    }

    await this.recordFailures(buildFailures, 'Re-encryption snapshot build failed', result)

    // The chunk already caps the item count
    const snapshotBatches = SizeAwareBatchAccumulator.batch(readySnapshots, {
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
        const [stored, unstored] = partition(batch, item => storedIds.has(item.snapshot.itemId))
        result.succeeded.push(...stored.map(item => item.snapshot.itemId))
        await this.recordFailures(
          unstored.map(({ snapshot }) => ({ itemId: snapshot.itemId, error })),
          'Re-encryption upload failed',
          result
        )
        continue
      }
      result.succeeded.push(...batch.map(item => item.snapshot.itemId))
    }
  }

  private buildSnapshotWithRetry(
    itemId: ItemId,
    signal?: AbortSignal
  ): Promise<Exclude<BuildSnapshotResult, { type: 'not-ready' | 'deferred' }>> {
    return RetryStrategy.executeWithRetry(
      async () => {
        const result = await this.deps.builder.build(itemId, 0, { signal })
        if (result.type === 'not-ready') {
          throw new Error(`Item ${itemId} document or vault was not ready`)
        }
        if (result.type === 'deferred') {
          if (result.reason === 'unpushed') {
            await this.deps.pushToLog([itemId], signal)
          }
          throw new DeferredBuildError(itemId, result.reason === 'unpushed')
        }
        return result
      },
      {
        maxAttempts: MAX_BATCH_RETRIES,
        delays: this.batchRetryDelays,
        signal,
        shouldRetry: err => {
          if (err instanceof DeferredBuildError) return err.canRetry
          const classified = classifySyncError(err)
          return !(classified.isNetwork || classified.isServerError || classified.isAuth)
        },
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
    batch: UploadableSnapshot[],
    storedIds: Set<ItemId>,
    signal?: AbortSignal
  ): Promise<void> {
    return RetryStrategy.executeWithRetry(
      async () => {
        const result = await uploadSnapshotBatch(batch, {
          accountId: this.deps.accountId,
          apiClient: this.deps.apiClient,
          recorder: this.deps.recorder,
          signal,
        })
        for (const item of result.stored) {
          storedIds.add(item.snapshot.itemId)
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
          if (classified.isAuth || isClientOutdatedError(err)) return false
          return this.deps.session.isOnline || !(classified.isNetwork || classified.isServerError)
        },
        onRetry: (err, attempt) => {
          log.warn(`Attempt ${attempt} failed to upload snapshots for batch:`, err)
        },
      }
    )
  }

  /**
   * Rethrows an upload error that should stop the whole run (an abort, an auth error, a refused build,
   * or a network or server error), and otherwise describes the permanent failure the batch's items are quarantined for.
   * `SyncApiClient` has already turned auth errors it couldn't recover from into `AuthExpiredError`.
   */
  private describeUploadFailure(err: unknown, signal?: AbortSignal): string {
    checkAlive(signal, true, 'Re-encryption aborted')
    const classified = classifySyncError(err)
    // A build the server refuses says nothing about these items, and a new build retries them
    if (isAbortError(err) || classified.isAuth || isClientOutdatedError(err)) {
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
        await this.deps.recoveryManager.quarantine(failure.itemId, 'snapshotFailure', `${stage}: ${failure.error}`)
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
