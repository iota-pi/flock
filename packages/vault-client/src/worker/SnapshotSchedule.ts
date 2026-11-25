import type { ItemId } from '@vault/shared'
import type { ItemSyncState } from './ItemSyncState'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncSessionState } from './SyncSessionState'
import { checkAlive, isAbortError } from '../utils/abort'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { createLogger } from '../utils/logger'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const log = createLogger('SnapshotSchedule')

export interface SnapshotScheduleOptions {
  /** The queue of dirty items, which the schedule marks and clears for its callers */
  state: Pick<ItemSyncState, 'load' | 'markDirty' | 'clearDirty' | 'queueFlagged' | 'dirtyCount'>
  recoveryManager: Pick<RecoveryManager, 'listRecoveryItems'>
  debounceDelayMs?: number
  maxWaitMs?: number
  session: SyncSessionState
  /** Called when snapshots may be due sooner than before, so the next poll can be brought forward */
  onDueChanged?: () => void
  now?: () => number
}

/**
 * When the dirty items' snapshots are due. `ItemSyncState` holds which items are dirty, with their
 * ticks and stored flags; this holds only the session's due times, retry and quota deferral.
 *
 * Marking an item here queues it and makes it due. Only the leader marks items: an edit is marked
 * when the leader records the acknowledgement of its push, and the leader alone uploads and so clears
 * them. After the records load, at start and on promotion, the flagged items that aren't quarantined
 * are queued again and made due.
 */
export class SnapshotSchedule {
  /**
   * When the dirty items' snapshots are due. An edit puts `debounceDueAt` off again, and `maxWaitDueAt`
   * bounds that for steady editing. A request with its own delay (`requestedDueAt`) isn't put off by edits.
   */
  private debounceDueAt: number | undefined
  private maxWaitDueAt: number | undefined
  private requestedDueAt: number | undefined
  /** Set when an upload failed, so the next poll tries again without a poll being brought forward */
  private retryAtNextPoll = false
  /** Nothing is due before this, after the server turned uploads away for the account's quota */
  private notBefore = 0
  private readonly debounceDelayMs: number
  private readonly maxWaitMs: number
  private readonly loadGuard = new SingleFlightGuard<void>()

  constructor(private readonly deps: SnapshotScheduleOptions) {
    this.debounceDelayMs = deps.debounceDelayMs ?? SYNC_TIMEOUTS.snapshotDebounce
    this.maxWaitMs = deps.maxWaitMs ?? SYNC_TIMEOUTS.snapshotMaxWait
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** Makes the pending uploads due when this tab becomes the leader, and drops them when it stops being one */
  onLeaderChange(): void {
    if (this.deps.session.isShutdown) return
    if (this.deps.session.isLeader) {
      if (this.deps.state.dirtyCount > 0) {
        this.scheduleDue()
      }
    } else {
      this.clearDue()
    }
  }

  markItemDirty(itemId: ItemId, customDebounceDelayMs?: number): void {
    if (this.deps.session.isShutdown || !itemId) return
    this.deps.state.markDirty(itemId)
    this.scheduleDue(customDebounceDelayMs)
  }

  /** Makes the dirty items due after the debounce, or after `customDelayMs` however later edits come */
  private scheduleDue(customDelayMs?: number): void {
    const now = this.now()
    if (customDelayMs === undefined) {
      this.debounceDueAt = now + this.debounceDelayMs
    } else {
      this.requestedDueAt = Math.min(this.requestedDueAt ?? Number.POSITIVE_INFINITY, now + customDelayMs)
    }
    this.maxWaitDueAt ??= now + this.maxWaitMs
    this.deps.onDueChanged?.()
  }

  /** Makes every dirty item due now, past any wait for the quota, such as when the page is closing */
  requestNow(): void {
    this.liftDeferral()
    this.requestedDueAt = this.now()
  }

  /**
   * When the next upload is due, for scheduling a poll, or undefined if none is. An upload left to
   * retry at the next poll doesn't count: it waits for the poll's own cadence or backoff.
   */
  get nextDueAt(): number | undefined {
    if (this.deps.state.dirtyCount === 0) return undefined
    const dueAt = Math.min(
      this.debounceDueAt ?? Number.POSITIVE_INFINITY,
      this.maxWaitDueAt ?? Number.POSITIVE_INFINITY,
      this.requestedDueAt ?? Number.POSITIVE_INFINITY,
    )
    return Number.isFinite(dueAt) ? Math.max(dueAt, this.notBefore) : undefined
  }

  /** Whether a poll now should upload the dirty items' snapshots */
  isDue(now = this.now()): boolean {
    if (this.deps.state.dirtyCount === 0) return false
    if (this.retryAtNextPoll && now >= this.notBefore) return true
    const dueAt = this.nextDueAt
    return dueAt !== undefined && dueAt <= now
  }

  /** Called as an upload starts: it takes every dirty item, so nothing stays due */
  clearDue(): void {
    this.debounceDueAt = undefined
    this.maxWaitDueAt = undefined
    this.requestedDueAt = undefined
    this.retryAtNextPoll = false
  }

  /** Called after an upload failed, so the items it left dirty go up at the next poll */
  retryNextPoll(): void {
    this.retryAtNextPoll = true
  }

  /**
   * Called when the server turned uploads away for the account's quota: none goes up before `time`,
   * in the snapshot phase or the rewrite phase
   */
  deferUntil(time: number): void {
    this.notBefore = time
    this.retryAtNextPoll = true
  }

  /** Whether uploads are waiting out the quota delay that `deferUntil` set */
  isDeferred(now = this.now()): boolean {
    return now < this.notBefore
  }

  /** Ends the quota delay, so the next poll tries the uploads again, such as for a new rewrite */
  liftDeferral(): void {
    this.notBefore = 0
  }

  /**
   * Loads the item records and queues the items they flag, at start and when this tab becomes the
   * leader. Concurrent callers share one load.
   */
  async load(): Promise<void> {
    if (this.deps.session.isShutdown) return
    await this.loadGuard.run(async () => {
      await this.deps.state.load()
      await this.restoreFlagged()
    })
  }

  /**
   * The startup and promotion audit, run once the item records have loaded: queues every flagged item
   * that isn't quarantined, due after `restoredSnapshotDelay` however later edits come.
   */
  private async restoreFlagged(): Promise<void> {
    if (this.deps.session.isShutdown) return
    try {
      const quarantinedIds = new Set<ItemId>()
      try {
        const recoveryEntries = await this.deps.recoveryManager.listRecoveryItems()
        checkAlive(null, () => !this.deps.session.isShutdown)
        for (const entry of recoveryEntries) {
          quarantinedIds.add(entry.itemId)
        }
      } catch (recoveryErr) {
        if (isAbortError(recoveryErr)) throw recoveryErr
        log.error('Failed to read manual recovery entries during startup audit', recoveryErr)
      }

      const auditCount = this.deps.state.queueFlagged(quarantinedIds)
      if (auditCount > 0) {
        log.info(`Startup audit restored ${auditCount} un-snapshotted items to dirty queue`)
        // Due soon, however later edits come: a fresh debounce could put them off session after session
        this.scheduleDue(Math.min(SYNC_TIMEOUTS.restoredSnapshotDelay, this.debounceDelayMs))
      }
    } catch (error) {
      if (isAbortError(error) || this.deps.session.isShutdown) return
      log.error('Failed to restore flagged items', error)
    }
  }

  /** Takes the item out of the queue, clearing its flag, and nothing stays due once none is left */
  deleteDirtyItem(itemId: ItemId): boolean {
    if (this.deps.session.isShutdown || !itemId) return false
    const deleted = this.deps.state.clearDirty(itemId)
    if (this.deps.state.dirtyCount === 0) {
      this.clearDue()
    }
    return deleted
  }

  /**
   * Forgets the session's due times, once a load in flight has finished. Called once, as the session
   * stops and after polling has. The queue goes, and the item records save, as `ItemSyncState` stops.
   */
  async shutdown(): Promise<void> {
    await this.loadGuard.waitForRunning()
    this.clearDue()
    this.notBefore = 0
    this.loadGuard.clear()
  }
}
