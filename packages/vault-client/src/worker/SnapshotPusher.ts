import type { SnapshotPushResult } from './syncProtocol'
import type { SyncApiClient } from './SyncApiClient'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { classifySyncError } from '../utils/errorClassifier'
import { type ItemId, MAX_ITEM_SIZE_BYTES, MAX_ITEM_SIZE_KB } from '@vault/shared'
import type { ClientEventHub } from './SyncEventHub'
import type { RecoveryManager } from './RecoveryManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AbortableRun } from '../utils/AbortableRun'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { RetryTimer } from '../utils/RetryTimer'
import { ConsecutiveFailureCounter } from '../utils/ConsecutiveFailureCounter'
import { checkAlive, isAbortError } from '../utils/abort'
import { SizeAwareBatchAccumulator } from '../utils/SizeAwareBatchAccumulator'
import type { SnapshotTracker } from './SnapshotTracker'
import { estimateSnapshotSize, type SnapshotBuilder, toTombstoneSnapshot, type PreparedSnapshotItem } from './snapshotBuilder'
import { fireAndForget } from '../utils/fireAndForget'
import { uploadSnapshotBatch, type SnapshotBatchResult, type UploadableSnapshot } from './snapshotUpload'
import { createLogger } from '../utils/logger'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('SnapshotPusher')

export interface SnapshotPusherOptions {
  accountId: string
  /** Only the leader uploads snapshots, and only while online */
  session: SyncSessionState
  tracker: SnapshotTracker
  builder: SnapshotBuilder
  broker: SyncMessageBroker
  recoveryManager: RecoveryManager
  apiClient: SyncApiClient
  eventHub: ClientEventHub
  getLatestCursor?: () => number
  maxPayloadBytes?: number
}

/** A push's result, and whether every batch in it was sent and accepted */
interface SnapshotPushOutcome extends SnapshotPushResult {
  success: boolean
}

/**
 * Whether an item goes in the push. `skip` leaves it out (it's no longer dirty, or it's oversized and
 * quarantined); `fail` also marks the push failed, so it's retried.
 */
type ItemPreparationResult =
  | { type: 'ready'; item: PreparedSnapshotItem; size: number }
  | { type: 'skip' }
  | { type: 'fail' }

const MAX_CONSECUTIVE_SNAPSHOT_FAILURES = 5

export class SnapshotPusher {
  private readonly maxPayloadBytes: number

  private readonly consecutiveFailures = new ConsecutiveFailureCounter<ItemId>(MAX_CONSECUTIVE_SNAPSHOT_FAILURES)
  private readonly pushGuard = new SingleFlightGuard<SnapshotPushOutcome>()
  private readonly pushRun = new AbortableRun(() => this.deps.session.isOperational)
  private pendingPushRequested = false
  private readonly retryTimer = new RetryTimer()
  private readonly retryStrategy = new RetryStrategy({ delays: DEFAULT_RETRY_DELAYS })

  constructor(private readonly deps: SnapshotPusherOptions) {
    this.maxPayloadBytes = deps.maxPayloadBytes ?? MAX_ITEM_SIZE_BYTES
  }

  get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  get isRetryActive(): boolean {
    return this.retryTimer.isPending
  }

  abortPush(): void {
    this.pushRun.abort()
  }

  cancelRetry(): void {
    this.retryTimer.cancel()
  }

  resetRetry(): void {
    this.retryStrategy.reset()
    this.cancelRetry()
  }

  /** Starts a push, or asks for another to follow the one already running */
  async triggerSnapshotPush(): Promise<SnapshotPushResult> {
    const { persisted, total } = await this.startPush()
    return { persisted, total }
  }

  scheduleRetry(): void {
    if (!this.deps.session.isOperational || this.retryTimer.isPending) {
      return
    }

    this.deps.tracker.clearDebounceTimers()

    const delayMs = this.retryStrategy.nextDelay()

    log.warn(`Scheduling snapshot push retry (attempt ${this.retryAttempt}) in ${delayMs}ms`)

    this.retryTimer.schedule(delayMs, () => {
      if (this.deps.tracker.dirtyCount > 0) {
        fireAndForget(this.triggerSnapshotPush(), 'SnapshotPusher:scheduleRetry')
      }
    })
  }

  private async handleSnapshotFailure(
    itemId: ItemId,
    tick: number,
    failureType: 'build' | 'upload',
    reason?: string,
  ): Promise<void> {
    if (this.consecutiveFailures.recordFailure(itemId)) {
      const detailedReason =
        reason ||
        `Snapshot ${failureType} failed after ${MAX_CONSECUTIVE_SNAPSHOT_FAILURES} consecutive attempts`
      log.error(
        `Item ${itemId} reached max consecutive snapshot ${failureType} failures (${MAX_CONSECUTIVE_SNAPSHOT_FAILURES}). Reason: ${detailedReason}. Moving to manual recovery.`,
      )
      this.deps.tracker.removeDirtyItemIfTickMatches(itemId, tick)

      this.deps.eventHub.emit({
        type: 'snapshotFailed',
        itemId,
        message: `Snapshot sync failed for item ${itemId}: ${detailedReason}. Changes are stored locally only.`,
      })

      try {
        await this.deps.recoveryManager.quarantine(
          itemId,
          'snapshotFailure',
          `Snapshot failure: ${detailedReason}`,
        )
      } catch (recoveryError) {
        log.error('Failed to record manual recovery entry', recoveryError)
      }
    }
  }

  private handleOversizedItem(
    itemId: ItemId,
    snapshotSize: number,
    modified: number,
  ): void {
    if (this.deps.tracker.recordOversized(itemId, modified)) {
      log.error(
        `Snapshot for item ${itemId} exceeds maxPayloadBytes (${snapshotSize} > ${this.maxPayloadBytes}). Skipping.`,
      )
      this.deps.eventHub.emit({
        type: 'snapshotFailed',
        itemId,
        message: `Snapshot for item ${itemId} (${Math.round(snapshotSize / 1024)} KB) exceeds the ${MAX_ITEM_SIZE_KB} KB limit. Recreating the item with fresh history is required to resume sync.`,
      })
      fireAndForget(
        this.deps.recoveryManager.quarantine(
          itemId,
          'oversized',
          `Snapshot size (${Math.round(snapshotSize / 1024)} KB) exceeds ${MAX_ITEM_SIZE_KB} KB limit. Recreating the item with fresh history is required to resume sync.`,
        ),
        'SnapshotPusher:quarantine',
      )
    }
  }

  private async prepareItemForPush(
    itemId: ItemId,
    snapshotCursor: number,
    signal?: AbortSignal,
  ): Promise<ItemPreparationResult> {
    const tick = this.deps.tracker.getDirtyTick(itemId)
    if (tick === undefined) {
      return { type: 'skip' }
    }

    // The build bounds its document lookup, so an unreadable document fails here rather than wedging the push
    const buildResult = await this.deps.builder.build(itemId, snapshotCursor, { signal })
    if (buildResult.type === 'not-ready') {
      return { type: 'fail' }
    }

    if (buildResult.type === 'error') {
      await this.handleSnapshotFailure(itemId, tick, 'build', buildResult.reason)
      return { type: 'fail' }
    }

    // Failures are counted until an upload is confirmed (see recordStoredSnapshots)
    const snapshot = buildResult.snapshot

    const snapshotSize = estimateSnapshotSize(snapshot)

    if (snapshotSize > this.maxPayloadBytes && snapshot.deleted === true) {
      // The full history can never be uploaded, but the server still needs to learn of the deletion
      this.deps.tracker.clearOversized(itemId)
      log.warn(`Uploading metadata-only tombstone for oversized deleted item ${itemId}`)
      const tombstone = toTombstoneSnapshot(snapshot)
      return {
        type: 'ready',
        item: { snapshot: tombstone, tick, heads: undefined },
        size: estimateSnapshotSize(tombstone),
      }
    }

    if (snapshotSize > this.maxPayloadBytes) {
      this.handleOversizedItem(itemId, snapshotSize, snapshot.modified)
      return { type: 'skip' }
    }

    this.deps.tracker.clearOversized(itemId)

    return {
      type: 'ready',
      item: { snapshot, tick, heads: buildResult.heads },
      size: snapshotSize,
    }
  }

  /** Records snapshots the server stored, whichever upload sent them */
  recordStoredSnapshots(stored: UploadableSnapshot[], versions: Map<ItemId, number>): void {
    for (const item of stored) {
      this.consecutiveFailures.reset(item.snapshot.itemId)
      const assignedVersion = versions.get(item.snapshot.itemId)
      this.deps.tracker.recordSnapshotSuccess(item.snapshot.itemId, item.snapshot.modified, item.tick, assignedVersion)
      this.deps.broker.confirmSnapshot(item.snapshot.itemId, item.heads)
      fireAndForget(
        this.deps.recoveryManager.unquarantine(item.snapshot.itemId),
        'SnapshotPusher:unquarantine',
      )
    }
  }

  /** Sends a batch. `responded` says whether the server answered. */
  private async flushBatch(
    batch: PreparedSnapshotItem[],
    signal?: AbortSignal,
  ): Promise<{ success: boolean; responded: boolean; persisted: number }> {
    let result: SnapshotBatchResult<PreparedSnapshotItem>
    try {
      result = await uploadSnapshotBatch(batch, {
        accountId: this.deps.accountId,
        apiClient: this.deps.apiClient,
        recorder: this,
        signal,
      })
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || classifySyncError(error).isAuth) {
        throw error
      }
      log.error('Failed to put snapshots', error)
      return { success: false, responded: false, persisted: 0 }
    }

    for (const item of result.rejected) {
      await this.handleSnapshotFailure(item.snapshot.itemId, item.tick, 'upload')
    }
    return { success: result.success, responded: true, persisted: result.persisted }
  }

  private async processSnapshotPush(
    dirtyItemIds: ItemId[],
    snapshotCursor: number,
    signal?: AbortSignal,
  ): Promise<SnapshotPushOutcome> {
    let persisted = 0
    let total = 0
    let success = true
    let sendFailed = false

    const accumulator = new SizeAwareBatchAccumulator<PreparedSnapshotItem>({ maxBatchBytes: this.maxPayloadBytes })

    /** Sends the accumulated batch, returning whether the server answered */
    const flushAccumulated = async (): Promise<boolean> => {
      const batch = accumulator.drain()
      total += batch.length
      checkAlive(signal, () => this.deps.session.isOperational)
      const result = await this.flushBatch(batch, signal)
      persisted += result.persisted
      if (!result.success) {
        success = false
      }
      return result.responded
    }

    for (const itemId of dirtyItemIds) {
      checkAlive(signal, () => this.deps.session.isOperational)
      const prepared = await this.prepareItemForPush(itemId, snapshotCursor, signal)
      if (prepared.type === 'fail') {
        success = false
      }
      if (prepared.type !== 'ready') {
        continue
      }

      if (accumulator.wouldExceed(prepared.size) && !accumulator.isEmpty) {
        // A batch the server answered can fail for its own items only; later batches still go
        if (!await flushAccumulated()) {
          sendFailed = true
          break
        }
      }

      accumulator.push(prepared.item, prepared.size)
    }

    // Flush any remaining items in the accumulator
    if (!sendFailed && !accumulator.isEmpty) {
      await flushAccumulated()
    }

    return { persisted, total, success }
  }

  /** Runs a push, or coalesces onto the running one and asks for another to follow it */
  private async startPush(): Promise<SnapshotPushOutcome> {
    if (!this.deps.session.isOperational) {
      return { persisted: 0, total: 0, success: true }
    }
    this.cancelRetry()

    // Only set when this call ran the push rather than coalescing onto one
    let settledSuccess: boolean | null = null
    const result = await this.pushGuard.run(
      () => this.executePush(success => {
        settledSuccess = success
      }),
      {
        onCoalesce: () => {
          this.pendingPushRequested = true
        },
      },
    )
    // Scheduled once the guard has cleared, or a follow-up push would coalesce onto the finishing one
    if (settledSuccess !== null) {
      this.handlePostPushScheduling(settledSuccess)
    }
    return result
  }

  private async executePush(onSettled: (success: boolean) => void): Promise<SnapshotPushOutcome> {
    let failed = false

    try {
      return await this.pushRun.run(async signal => {
        const dirtyItemIds = this.deps.session.isOperational ? this.deps.tracker.getDirtyItemIds() : []
        if (dirtyItemIds.length === 0) {
          failed = this.deps.tracker.dirtyCount > 0
          return { persisted: 0, total: 0, success: !failed }
        }

        checkAlive(signal, () => this.deps.session.isOperational)
        const result = await this.processSnapshotPush(dirtyItemIds, this.deps.getLatestCursor?.() ?? 0, signal)
        failed = !result.success
        if (result.success && this.deps.tracker.dirtyCount === 0) {
          this.retryStrategy.reset()
        }
        return result
      })
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isAbort) {
        return { persisted: 0, total: 0, success: false }
      }
      failed = true
      if (classified.isAuth) {
        log.warn('Cannot push snapshots: auth failure', error)
      } else {
        log.error('Error during pushSnapshots', error)
      }
      return { persisted: 0, total: 0, success: false }
    } finally {
      onSettled(!failed)
    }
  }

  private handlePostPushScheduling(success: boolean): void {
    const hasDirtyDocs = this.deps.tracker.dirtyCount > 0
    const wasPending = this.pendingPushRequested
    this.pendingPushRequested = false

    if (!success && hasDirtyDocs && this.deps.session.isOperational) {
      this.scheduleRetry()
    } else if (wasPending && hasDirtyDocs && this.deps.session.isOperational) {
      fireAndForget(this.triggerSnapshotPush(), 'SnapshotPusher:handlePostPushScheduling')
    }
  }

  async flushPendingSnapshots(): Promise<SnapshotPushResult> {
    this.deps.tracker.clearDebounceTimers()
    if (!this.deps.session.isOperational) {
      return { persisted: 0, total: 0 }
    }
    if (this.deps.tracker.dirtyCount === 0 && !this.pushGuard.isRunning) {
      return { persisted: 0, total: 0 }
    }

    let persisted = 0
    let total = 0

    while (this.pushGuard.isRunning || this.deps.tracker.dirtyCount > 0) {
      // Waits on a running push without asking for a follow-up; flushing loops on its own
      const result = this.pushGuard.isRunning
        ? await this.pushGuard.waitForRunning()
        : await this.startPush()
      if (!result) {
        break
      }
      persisted += result.persisted
      total += result.total
      if (!result.success || (result.persisted === 0 && this.deps.tracker.dirtyCount > 0)) {
        break
      }
    }

    return { persisted, total }
  }

  clear(): void {
    this.cancelRetry()
    this.consecutiveFailures.clear()
    this.pendingPushRequested = false
    this.pushGuard.clear()
    this.retryStrategy.reset()
  }

  async shutdown(): Promise<void> {
    this.abortPush()
    await this.pushGuard.waitForRunning()
    this.clear()
  }
}
