import type { SnapshotPushResult } from './syncProtocol'
import type { SyncApiClient } from './SyncApiClient'
import { classifySyncError, isRequestFailure } from '../utils/errorClassifier'
import { type ItemId, MAX_ITEM_SIZE_BYTES, MAX_ITEM_SIZE_KB } from '@vault/shared'
import type { ClientEventHub } from './SyncEventHub'
import type { RecoveryManager } from './RecoveryManager'
import { ConsecutiveFailureCounter } from '../utils/ConsecutiveFailureCounter'
import { checkAlive, isAbortError } from '../utils/abort'
import { SizeAwareBatchAccumulator } from '../utils/SizeAwareBatchAccumulator'
import type { SnapshotSchedule } from './SnapshotSchedule'
import type { ItemSyncState } from './ItemSyncState'
import {
  buildAfterPush,
  estimateSnapshotSize,
  type SnapshotBuilder,
  toTombstoneSnapshot,
} from './SnapshotBuilder'
import { fireAndForget } from '../utils/fireAndForget'
import {
  uploadSnapshotBatch,
  type SnapshotBatchResult,
  type StoredSnapshotDetails,
  type StoredSnapshotRecorder,
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
  schedule: Pick<SnapshotSchedule, 'requestNow' | 'isDue' | 'clearDue' | 'retryNextPoll' | 'deferUntil'>
  /**
   * Which items are dirty, which a stored snapshot clears and whose base version it raises. Saved at
   * once when flushing, in case the page is closing.
   */
  state: Pick<
    ItemSyncState,
    'flushPendingSave' | 'dirtyCount' | 'listDirty' | 'getDirtyTick' | 'clearDirty' | 'raiseBaseVersion'
  >
  builder: Pick<SnapshotBuilder, 'build'>
  /** Pushes items' changes to the log, which comes before their snapshots */
  pushToLog: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
  /**
   * Writes the items' docs to storage, which has to happen before their snapshots count as stored.
   * Otherwise a crash could leave the device without changes its base version says it has.
   */
  storeDocs: (itemIds: ItemId[]) => Promise<void>
  /** Called with each snapshot the server stored */
  onSnapshotStored: (details: StoredSnapshotDetails) => void
  recoveryManager: RecoveryManager
  apiClient: SyncApiClient
  eventHub: ClientEventHub
  maxPayloadBytes?: number
  /** Runs a poll now, or right after the one in flight, resolving once it has finished */
  runPollNow: () => Promise<void>
  /**
   * Whether the device has caught up (`SyncLogPuller.isCaughtUp`). Until then nothing is uploaded,
   * since a snapshot could replace one holding what the doc hasn't merged yet.
   */
  isCaughtUp: () => boolean
  /**
   * Whether any item has a pending mark. A pushed mark's acknowledgement makes its item dirty in
   * the same poll, so a flush with nothing dirty yet still has something to upload.
   */
  hasPendingMarks: () => Promise<boolean>
}

/** A push's result, and whether every batch in it was sent and accepted */
export interface SnapshotPushOutcome extends SnapshotPushResult {
  success: boolean
}

/** What became of one item in `uploadItems` */
export type ItemUploadResult =
  | { type: 'stored' }
  /** Over the size limit, and quarantined as oversized (once). Retrying won't help. */
  | { type: 'oversized'; sizeBytes: number }
  /**
   * Its build or upload failed, which counts towards quarantining it. `quarantined` says this failure
   * reached the limit, so the item is now quarantined.
   */
  | { type: 'failed'; stage: 'build' | 'upload'; reason?: string; quarantined: boolean }
  /** Not built: its doc or the vault isn't ready, or it still waits for the log. Counts no failure. */
  | { type: 'waiting'; reason: 'not-ready' | 'deferred' }

export interface UploadItemsOptions {
  signal: AbortSignal
  /**
   * Builds and uploads items that aren't dirty too, as a rewrite does. Otherwise they're skipped: an
   * item that is no longer dirty has been uploaded already.
   */
  includeClean?: boolean
  /** Called once for each item the run settles. A skipped item, or one a failed request left, gets none. */
  onItemResult?: (itemId: ItemId, result: ItemUploadResult) => void
}

/**
 * Whether an item goes in the push. `skip` leaves it out (it's no longer dirty, or it's oversized and
 * quarantined); `fail` also marks the push failed, so it's retried.
 */
type ItemPreparationResult =
  | { type: 'ready'; item: UploadableSnapshot; size: number }
  | { type: 'skip' }
  | { type: 'fail' }

/** How many failed builds or uploads in a row quarantine an item */
export const MAX_CONSECUTIVE_SNAPSHOT_FAILURES = 5

/** The server turned a snapshot upload away (429), most likely for the account's storage quota */
class SnapshotsRefusedError extends Error {
  constructor(cause: unknown) {
    super('The server turned the snapshot upload away', { cause })
    this.name = 'SnapshotsRefusedError'
  }
}

/**
 * Uploads the dirty items' snapshots (`ItemSyncState`) when `SnapshotSchedule` says they're due. Uploads run as the last phase of each
 * poll (`pushDue`), so they share the poll's leadership, online state, abort, auth handling and
 * backoff. `uploadItems` is the one per-item pipeline (build after push, size limit, batching,
 * failure counting and quarantine), which `SnapshotRewriter` runs too.
 */
export class SnapshotPusher implements StoredSnapshotRecorder {
  private readonly maxPayloadBytes: number

  private readonly consecutiveFailures = new ConsecutiveFailureCounter<ItemId>(MAX_CONSECUTIVE_SNAPSHOT_FAILURES)
  /** Items found too large to upload this session, so the warning is given only once */
  private readonly oversizedItems = new Set<ItemId>()
  private lastPush: SnapshotPushResult = { persisted: 0, total: 0 }
  private pushes = 0

  constructor(private readonly deps: SnapshotPusherOptions) {
    this.maxPayloadBytes = deps.maxPayloadBytes ?? MAX_ITEM_SIZE_BYTES
  }

  /**
   * The poll's snapshot phase, and the manifest phase's upload before it fetches the manifest. Both
   * run inside the poll, so never at once. Uploads every dirty item's snapshot if they're due.
   *
   * Throws if a request fails, so the poll fails (sync rule 4), except when the server turns snapshots
   * away for the account's quota (429): that defers them and leaves the poll's result alone, since
   * pulls still work. Items a push leaves dirty after a failure go up at the next poll.
   *
   * Uploads nothing until the device has caught up, leaving what's due for the snapshot phase of the
   * poll that does. Catch-up's own manifest sync would otherwise upload before it has merged the
   * server's snapshots: a device away longer than the log's TTL, or one that has just reset its
   * sync state, can hold a doc that lacks what only the server's snapshot holds.
   */
  async pushDue(signal: AbortSignal): Promise<SnapshotPushOutcome> {
    if (!this.deps.isCaughtUp()) return { persisted: 0, total: 0, success: true }
    const result = await this.pushDueSnapshots(signal)
    if (result.total > 0 || !result.success) {
      this.lastPush = { persisted: result.persisted, total: result.total }
      this.pushes += 1
    }
    return result
  }

  /**
   * Uploads every dirty item's snapshot now, with a poll, such as when the page may be closing. Items
   * with pending marks go too: the poll pushes them to the log first, and their acknowledgement makes
   * them dirty, due in the same poll's snapshot phase. Never call it from inside a poll, which it
   * would wait for.
   */
  async flushPendingSnapshots(): Promise<SnapshotPushResult> {
    const { schedule, session, state } = this.deps
    // Saved first, in case the page is closing
    state.flushPendingSave()
    if (!session.isOperational) return { persisted: 0, total: 0 }
    if (state.dirtyCount === 0 && !(await this.deps.hasPendingMarks())) {
      return { persisted: 0, total: 0 }
    }
    schedule.requestNow()
    const pushesBefore = this.pushes
    await this.deps.runPollNow()
    // Nothing became dirty, so the request mustn't make a later edit's snapshot due at once
    if (state.dirtyCount === 0) schedule.clearDue()
    return this.pushes > pushesBefore ? this.lastPush : { persisted: 0, total: 0 }
  }

  /**
   * Builds and uploads the items' snapshots: the one pipeline that both the snapshot phase and the
   * rewrite phase run. Each item is built only through `buildAfterPush`, which pushes it to the log
   * first if it holds changes the log lacks (S1). Throws if a request fails (sync rule 4), and `SnapshotsRefusedError` if
   * the server turns an upload away for the quota; the items not yet settled then get no result.
   */
  async uploadItems(itemIds: ItemId[], options: UploadItemsOptions): Promise<SnapshotPushOutcome> {
    const { signal } = options
    let persisted = 0
    let total = 0
    let success = true

    // The poll has pushed pending marks already, so an item holding changes the log lacks is rare: its build pushes it (S1)
    const accumulator = new SizeAwareBatchAccumulator<UploadableSnapshot>({ maxBatchBytes: this.maxPayloadBytes })

    const flushAccumulated = async (): Promise<void> => {
      const batch = accumulator.drain()
      total += batch.length
      checkAlive(signal, () => this.deps.session.isOperational)
      const result = await this.flushBatch(batch, options)
      persisted += result.persisted
      if (!result.success) {
        success = false
      }
    }

    for (const itemId of itemIds) {
      checkAlive(signal, () => this.deps.session.isOperational)
      const prepared = await this.prepareItemForPush(itemId, options)
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

  private async pushDueSnapshots(signal: AbortSignal): Promise<SnapshotPushOutcome> {
    const { schedule, session, state } = this.deps
    if (!session.isOperational || !schedule.isDue()) {
      return { persisted: 0, total: 0, success: true }
    }
    schedule.clearDue()
    const dirtyItemIds = state.listDirty()

    let result: SnapshotPushOutcome
    try {
      result = await this.uploadItems(dirtyItemIds, { signal })
    } catch (error) {
      if (error instanceof SnapshotsRefusedError) {
        log.warn('The server turned snapshots away; uploading them later', error.cause)
        schedule.deferUntil(Date.now() + SYNC_TIMEOUTS.snapshotQuotaRetry)
        return { persisted: 0, total: 0, success: false }
      }
      schedule.retryNextPoll()
      throw error
    }
    if (!result.success) {
      schedule.retryNextPoll()
    }
    return result
  }

  /** Counts a failure, quarantining the item once they reach the limit. Returns whether it did. */
  private async handleSnapshotFailure(
    itemId: ItemId,
    tick: number | undefined,
    failureType: 'build' | 'upload',
    reason?: string,
  ): Promise<boolean> {
    if (!this.consecutiveFailures.recordFailure(itemId)) return false

    const detailedReason =
      reason ||
      `Snapshot ${failureType} failed after ${MAX_CONSECUTIVE_SNAPSHOT_FAILURES} consecutive attempts`
    log.error(
      `Item ${itemId} reached max consecutive snapshot ${failureType} failures (${MAX_CONSECUTIVE_SNAPSHOT_FAILURES}). Reason: ${detailedReason}. Moving to manual recovery.`,
    )
    // An item built while clean (by a rewrite) has no tick, and nothing to take out of the queue
    if (tick !== undefined) this.deps.state.clearDirty(itemId, tick)

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
    return true
  }

  private async handleOversizedItem(itemId: ItemId, snapshotSize: number): Promise<void> {
    // Unconditionally, and with its flag, to avoid infinite retry loops while it's quarantined
    this.deps.state.clearDirty(itemId)
    if (this.oversizedItems.has(itemId)) return
    this.oversizedItems.add(itemId)
    // An earlier session quarantined it, and gave the warning then
    if (await this.isQuarantinedAsOversized(itemId)) return

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

  private async isQuarantinedAsOversized(itemId: ItemId): Promise<boolean> {
    try {
      const entries = await this.deps.recoveryManager.listRecoveryItems()
      return entries.some(entry => entry.itemId === itemId && entry.kind === 'oversized')
    } catch (error) {
      log.warn('Failed to read manual recovery entries', error)
      return false
    }
  }

  /** Forgets that the item was found oversized, so finding it again warns again, such as after a retry */
  clearOversized(itemId: ItemId): void {
    this.oversizedItems.delete(itemId)
  }

  private async prepareItemForPush(itemId: ItemId, options: UploadItemsOptions): Promise<ItemPreparationResult> {
    const { signal, onItemResult } = options
    // A dirty item's tick goes with its snapshot even in a rewrite, since the build holds its pending edits
    const tick = this.deps.state.getDirtyTick(itemId)
    if (tick === undefined && !options.includeClean) {
      return { type: 'skip' }
    }

    // The build bounds its document lookup, so an unreadable document fails here rather than wedging the push
    const buildResult = await buildAfterPush(this.deps.builder, this.deps.pushToLog, itemId, signal)

    if (buildResult.type === 'not-ready' || buildResult.type === 'deferred') {
      onItemResult?.(itemId, { type: 'waiting', reason: buildResult.type })
      return { type: 'fail' }
    }

    if (buildResult.type === 'error') {
      const quarantined = await this.handleSnapshotFailure(itemId, tick, 'build', buildResult.reason)
      onItemResult?.(itemId, { type: 'failed', stage: 'build', reason: buildResult.reason, quarantined })
      return { type: 'fail' }
    }

    // Failures are counted until an upload is confirmed (see recordStoredSnapshots)
    const snapshot = buildResult.snapshot

    const snapshotSize = estimateSnapshotSize(snapshot)

    if (snapshotSize > this.maxPayloadBytes && snapshot.deleted === true) {
      // The full history can never be uploaded, but the server still needs to learn of the deletion
      this.clearOversized(itemId)
      log.warn(`Uploading metadata-only tombstone for oversized deleted item ${itemId}`)
      const tombstone = toTombstoneSnapshot(snapshot)
      return {
        type: 'ready',
        item: { snapshot: tombstone, tick, heads: undefined },
        size: estimateSnapshotSize(tombstone),
      }
    }

    if (snapshotSize > this.maxPayloadBytes) {
      await this.handleOversizedItem(itemId, snapshotSize)
      onItemResult?.(itemId, { type: 'oversized', sizeBytes: snapshotSize })
      return { type: 'skip' }
    }

    this.clearOversized(itemId)

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
      this.recordSnapshotSuccess(itemId, item.tick, versions.get(itemId))
      this.deps.onSnapshotStored({ itemId, heads: item.heads })
      fireAndForget(
        this.deps.recoveryManager.unquarantine(item.snapshot.itemId),
        'SnapshotPusher:unquarantine',
      )
    }
  }

  /**
   * The item leaves the queue if its tick hasn't moved, and its base version rises to the stored one.
   * Without a tick, the item stays dirty: the snapshot wasn't built for its pending edits.
   */
  private recordSnapshotSuccess(itemId: ItemId, tick: number | undefined, version: number | undefined): void {
    if (tick !== undefined) this.deps.state.clearDirty(itemId, tick)
    if (version !== undefined) this.deps.state.raiseBaseVersion(itemId, version)
  }

  /**
   * Sends a batch. Throws if the request fails (sync rule 4), and `SnapshotsRefusedError` if the
   * server turns it away (429). Any other error is the batch's own, so it counts against its items.
   */
  private async flushBatch(
    batch: UploadableSnapshot[],
    options: UploadItemsOptions,
  ): Promise<{ success: boolean; persisted: number }> {
    const { signal, onItemResult } = options
    try {
      await this.deps.storeDocs(batch.map(item => item.snapshot.itemId))
    } catch (error) {
      // A storage failure says nothing about the items, so it counts none against them, and they stay dirty
      log.error('Failed to store docs; not uploading their snapshots', error)
      return { success: false, persisted: 0 }
    }

    let result: SnapshotBatchResult<UploadableSnapshot>
    try {
      result = await uploadSnapshotBatch(batch, {
        accountId: this.deps.accountId,
        apiClient: this.deps.apiClient,
        recorder: this,
        signal,
      })
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw error
      if (classifySyncError(error).status === 429) {
        throw new SnapshotsRefusedError(error)
      }
      // `SyncApiClient` has already turned auth errors it couldn't recover from into `AuthExpiredError`
      if (isRequestFailure(error)) throw error
      log.warn('The server rejected a snapshot batch', error)
      result = { success: false, persisted: 0, stored: [], rejected: batch }
    }

    for (const item of result.stored) {
      onItemResult?.(item.snapshot.itemId, { type: 'stored' })
    }
    for (const item of result.rejected) {
      const quarantined = await this.handleSnapshotFailure(item.snapshot.itemId, item.tick, 'upload')
      onItemResult?.(item.snapshot.itemId, { type: 'failed', stage: 'upload', quarantined })
    }
    return { success: result.success, persisted: result.persisted }
  }

  /** Called once polling has stopped, so no upload is in flight */
  shutdown(): void {
    this.consecutiveFailures.clear()
    this.oversizedItems.clear()
  }
}
