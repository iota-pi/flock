import type { ItemId } from '@vault/shared'
import type { ItemSyncState } from './ItemSyncState'
import type { SyncSessionState } from './SyncSessionState'
import {
  INITIAL_SNAPSHOT_DUE_STATE,
  isSnapshotDeferred,
  isSnapshotDue,
  snapshotDueAt,
  transitionSnapshotDue,
  type SnapshotDueEvent,
  type SnapshotDueState,
} from './snapshotDue'
import { createLogger } from '../utils/logger'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const log = createLogger('SnapshotSchedule')

export interface SnapshotScheduleOptions {
  /** The queue of dirty items, which the schedule marks and clears for its callers */
  state: Pick<ItemSyncState, 'markDirty' | 'clearDirty' | 'queueFlagged' | 'dirtyCount'>
  session: Pick<SyncSessionState, 'isShutdown'>
  /** Called when snapshots may be due sooner than before, so the next poll can be brought forward */
  onDueChanged?: () => void
  now?: () => number
}

/**
 * When the dirty items' snapshots are due. `ItemSyncState` holds which items are dirty; this holds
 * the session's due state (`snapshotDue.ts`) and applies its transitions, marking and clearing items
 * in the state as it goes. It dies with the session, so it has nothing to load or stop.
 */
export class SnapshotSchedule {
  private due: SnapshotDueState = INITIAL_SNAPSHOT_DUE_STATE

  constructor(private readonly deps: SnapshotScheduleOptions) {}

  private context() {
    return { now: this.deps.now?.() ?? Date.now(), dirtyCount: this.deps.state.dirtyCount }
  }

  private apply(event: SnapshotDueEvent): void {
    this.due = transitionSnapshotDue(this.due, event, this.context())
  }

  /** Queues the item and makes it due, after `delayMs` if given however later edits come */
  markItemDirty(itemId: ItemId, delayMs?: number): void {
    if (this.deps.session.isShutdown || !itemId) return
    this.deps.state.markDirty(itemId)
    this.apply({ type: 'marked', delayMs })
    this.deps.onDueChanged?.()
  }

  /**
   * Queues the items an earlier session left flagged, once the records have loaded, due after
   * `restoredSnapshotDelay` however later edits come: a fresh debounce could put them off session
   * after session. Returns how many it queued.
   */
  queueRestored(itemIds: Iterable<ItemId>): number {
    if (this.deps.session.isShutdown) return 0
    const count = this.deps.state.queueFlagged(itemIds)
    if (count > 0) {
      log.info(`Startup audit restored ${count} un-snapshotted items to dirty queue`)
      this.apply({ type: 'marked', delayMs: SYNC_TIMEOUTS.restoredSnapshotDelay })
      this.deps.onDueChanged?.()
    }
    return count
  }

  /**
   * Makes every dirty item due now. `pastQuota` lifts a quota deferral too, which only the page
   * closing or the user asking should: a request from inside sync would send another batch to be refused.
   */
  requestNow(options: { pastQuota: boolean }): void {
    this.apply({ type: 'requestNow', pastQuota: options.pastQuota })
  }

  /** When the next upload is due, for scheduling a poll, or undefined if none is */
  get nextDueAt(): number | undefined {
    return snapshotDueAt(this.due, this.context())
  }

  /** Whether a poll now should upload the dirty items' snapshots */
  isDue(): boolean {
    return isSnapshotDue(this.due, this.context())
  }

  /** Called as an upload starts: it takes every dirty item, so nothing stays due */
  clearDue(): void {
    this.apply({ type: 'uploadStarted' })
  }

  /** Called after an upload failed, so the items it left dirty go up at the next poll */
  retryNextPoll(): void {
    this.apply({ type: 'uploadFailed' })
  }

  /**
   * Called when the server turned uploads away for the account's quota: none goes up before `time`,
   * in the snapshot phase or the rewrite phase
   */
  deferUntil(time: number): void {
    this.apply({ type: 'refused', until: time })
  }

  /** Whether uploads are waiting out the quota delay that `deferUntil` set */
  isDeferred(): boolean {
    return isSnapshotDeferred(this.due, this.context().now)
  }

  /** Ends the quota delay, so the next poll tries the uploads again, such as for a new rewrite */
  liftDeferral(): void {
    this.apply({ type: 'deferralLifted' })
  }

  /** Takes the item out of the queue, clearing its flag, and nothing stays due once none is left */
  deleteDirtyItem(itemId: ItemId): boolean {
    if (this.deps.session.isShutdown || !itemId) return false
    const deleted = this.deps.state.clearDirty(itemId)
    this.apply({ type: 'dequeued' })
    return deleted
  }
}
