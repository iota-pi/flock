import type { SnapshotPushResult } from './syncProtocol'
import type { SyncApiClient } from './SyncApiClient'
import { classifySyncError } from '../utils/errorClassifier'
import { type ItemId, MAX_ITEM_SIZE_BYTES, MAX_ITEM_SIZE_KB } from '@vault/shared'
import type { ClientEventHub } from './SyncEventHub'
import type { RecoveryManager } from './RecoveryManager'
import { ConsecutiveFailureCounter } from '../utils/ConsecutiveFailureCounter'
import { checkAlive } from '../utils/abort'
import { SizeAwareBatchAccumulator } from '../utils/SizeAwareBatchAccumulator'
import type { SnapshotTracker } from './SnapshotTracker'
import { estimateSnapshotSize, type SnapshotBuilder, toTombstoneSnapshot, type PreparedSnapshotItem } from './SnapshotBuilder'
import { fireAndForget } from '../utils/fireAndForget'
import {
  uploadSnapshotBatch,
  type SnapshotBatchResult,
  type StoredSnapshotDetails,
  type UploadableSnapshot,
} from './snapshotUpload'
import { createLogger } from '../utils/logger'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('SnapshotPusher')

export interface SnapshotPusherOptions {
  accountId: string
  /** Only the leader uploads snapshots, and only while online */
  session: SyncSessionState
  tracker: SnapshotTracker
  builder: SnapshotBuilder
  /** Pushes items' changes to the log, which comes before their snapshots */
  pushToLog: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
  /** Called with each snapshot the server stored */
  onSnapshotStored: (details: StoredSnapshotDetails) => void
  recoveryManager: RecoveryManager
  apiClient: SyncApiClient
  eventHub: ClientEventHub
  maxPayloadBytes?: number
}

/** A push's result, and whether every batch in it was sent and accepted */
export interface SnapshotPushOutcome extends SnapshotPushResult {
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

/** The server turned a snapshot upload away (429), most likely for the account's storage quota */
class SnapshotsRefusedError extends Error {
  constructor(cause: unknown) {
    super('The server turned the snapshot upload away', { cause })
    this.name = 'SnapshotsRefusedError'
  }
}

export class SnapshotPusher {
  private readonly maxPayloadBytes: number

  private readonly consecutiveFailures = new ConsecutiveFailureCounter<ItemId>(MAX_CONSECUTIVE_SNAPSHOT_FAILURES)

  constructor(private readonly deps: SnapshotPusherOptions) {
    this.maxPayloadBytes = deps.maxPayloadBytes ?? MAX_ITEM_SIZE_BYTES
  }

  /**
   * The poll's snapshot phase: uploads every dirty item's snapshot if they're due. Throws if a request
   * fails, so the poll fails (sync rule 4), except when the server turns snapshots away for the
   * account's quota (429): that defers them and leaves the poll's result alone, since pulls still work.
   * Items a push leaves dirty after a failure go up at the next poll.
   */
  async pushDue(signal: AbortSignal): Promise<SnapshotPushOutcome> {
    const { tracker, session } = this.deps
    if (!session.isOperational || !tracker.isDue()) {
      return { persisted: 0, total: 0, success: true }
    }
    tracker.clearDue()
    const dirtyItemIds = tracker.getDirtyItemIds()

    let result: SnapshotPushOutcome
    try {
      result = await this.processSnapshotPush(dirtyItemIds, signal)
    } catch (error) {
      if (error instanceof SnapshotsRefusedError) {
        log.warn('The server turned snapshots away; uploading them later', error.cause)
        tracker.deferUntil(Date.now() + SYNC_TIMEOUTS.snapshotQuotaRetry)
        return { persisted: 0, total: 0, success: false }
      }
      tracker.retryNextPoll()
      throw error
    }
    if (!result.success) {
      tracker.retryNextPoll()
    }
    return result
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
          { code: 'snapshotFailed', stage: failureType },
        )
      } catch (recoveryError) {
        log.error('Failed to record manual recovery entry', recoveryError)
      }
    }
  }

  private handleOversizedItem(itemId: ItemId, snapshotSize: number): void {
    if (this.deps.tracker.recordOversized(itemId)) {
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
          { code: 'oversized', sizeKb: Math.round(snapshotSize / 1024) },
        ),
        'SnapshotPusher:quarantine',
      )
    }
  }

  private async prepareItemForPush(itemId: ItemId, signal?: AbortSignal): Promise<ItemPreparationResult> {
    const tick = this.deps.tracker.getDirtyTick(itemId)
    if (tick === undefined) {
      return { type: 'skip' }
    }

    // The build bounds its document lookup, so an unreadable document fails here rather than wedging the push
    let buildResult = await this.deps.builder.build(itemId, { signal })
    if (buildResult.type === 'deferred' && buildResult.reason === 'unpushed') {
      // Changes made since the push that started this upload
      await this.deps.pushToLog([itemId], signal)
      buildResult = await this.deps.builder.build(itemId, { signal })
    }

    if (buildResult.type === 'not-ready') {
      return { type: 'fail' }
    }

    if (buildResult.type === 'deferred') {
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
      this.handleOversizedItem(itemId, snapshotSize)
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
      const { itemId } = item.snapshot
      this.consecutiveFailures.reset(itemId)
      this.deps.tracker.recordSnapshotSuccess(itemId, item.tick, versions.get(itemId))
      this.deps.onSnapshotStored({ itemId, heads: item.heads })
      fireAndForget(
        this.deps.recoveryManager.unquarantine(item.snapshot.itemId),
        'SnapshotPusher:unquarantine',
      )
    }
  }

  /** Sends a batch. Throws if the request fails, and `SnapshotsRefusedError` if the server turns it away. */
  private async flushBatch(
    batch: PreparedSnapshotItem[],
    signal?: AbortSignal,
  ): Promise<{ success: boolean; persisted: number }> {
    let result: SnapshotBatchResult<PreparedSnapshotItem>
    try {
      result = await uploadSnapshotBatch(batch, {
        accountId: this.deps.accountId,
        apiClient: this.deps.apiClient,
        recorder: this,
        signal,
      })
    } catch (error) {
      if (!signal?.aborted && classifySyncError(error).status === 429) {
        throw new SnapshotsRefusedError(error)
      }
      throw error
    }

    for (const item of result.rejected) {
      await this.handleSnapshotFailure(item.snapshot.itemId, item.tick, 'upload')
    }
    return { success: result.success, persisted: result.persisted }
  }

  private async processSnapshotPush(dirtyItemIds: ItemId[], signal: AbortSignal): Promise<SnapshotPushOutcome> {
    let persisted = 0
    let total = 0
    let success = true

    // The poll has pushed pending marks already. This catches the items marked only for a snapshot.
    await this.deps.pushToLog(dirtyItemIds, signal)

    const accumulator = new SizeAwareBatchAccumulator<PreparedSnapshotItem>({ maxBatchBytes: this.maxPayloadBytes })

    const flushAccumulated = async (): Promise<void> => {
      const batch = accumulator.drain()
      total += batch.length
      checkAlive(signal, () => this.deps.session.isOperational)
      const result = await this.flushBatch(batch, signal)
      persisted += result.persisted
      if (!result.success) {
        success = false
      }
    }

    for (const itemId of dirtyItemIds) {
      checkAlive(signal, () => this.deps.session.isOperational)
      const prepared = await this.prepareItemForPush(itemId, signal)
      if (prepared.type === 'fail') {
        success = false
      }
      if (prepared.type !== 'ready') {
        continue
      }

      // A batch the server answered can fail for its own items only; later batches still go
      if (accumulator.wouldExceed(prepared.size) && !accumulator.isEmpty) {
        await flushAccumulated()
      }

      accumulator.push(prepared.item, prepared.size)
    }

    if (!accumulator.isEmpty) {
      await flushAccumulated()
    }

    return { persisted, total, success }
  }

  clear(): void {
    this.consecutiveFailures.clear()
  }
}
