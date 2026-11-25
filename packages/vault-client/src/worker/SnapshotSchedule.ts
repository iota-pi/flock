import type { ItemId } from '@vault/shared'
import type { ItemSyncState } from './ItemSyncState'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncSessionState } from './SyncSessionState'
import { checkAlive, isAbortError } from '../utils/abort'
import { createLogger } from '../utils/logger'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const log = createLogger('SnapshotSchedule')

export interface SnapshotScheduleOptions {
  /** Where each item's dirty flag and base version are kept */
  state: Pick<ItemSyncState, 'setDirty' | 'raiseBaseVersion' | 'listFlagged'>
  recoveryManager: Pick<RecoveryManager, 'listRecoveryItems'>
  debounceDelayMs?: number
  maxWaitMs?: number
  session: SyncSessionState
  /** Called when snapshots may be due sooner than before, so the next poll can be brought forward */
  onDueChanged?: () => void
  now?: () => number
}

/**
 * The session's queue of items that owe the server a snapshot, and when their uploads are due.
 *
 * Within a session the dirty items are counted with ticks, so an edit made while an upload is in
 * flight keeps the item dirty. Across sessions, each item's sync record carries a `dirty` flag
 * (`ItemSyncState`), set when the item is queued and cleared when it leaves the queue, and the startup
 * and promotion audit (`restoreFlagged`) queues every flagged item again. Only the leader queues
 * items: an edit is queued when the leader records the acknowledgement of its push, and the leader
 * alone uploads and so takes them out.
 */
export class SnapshotSchedule {
  private readonly dirtyItems = new Map<ItemId, number>()
  private dirtyItemsTick = 0
  /** Items quarantined as too large to upload, so the warning is given only once */
  private readonly oversizedItems = new Set<ItemId>()

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
      if (this.dirtyItems.size > 0) {
        this.scheduleDue()
      }
    } else {
      this.clearDue()
    }
  }

  markItemDirty(itemId: ItemId, customDebounceDelayMs?: number): void {
    if (this.deps.session.isShutdown || !itemId) return
    this.queue(itemId)
    this.deps.state.setDirty(itemId, true)
    this.scheduleDue(customDebounceDelayMs)
  }

  private queue(itemId: ItemId): void {
    this.dirtyItemsTick += 1
    this.dirtyItems.set(itemId, this.dirtyItemsTick)
  }

  /** Drops the item from the queue, clearing its flag */
  private removeDirty(itemId: ItemId): boolean {
    const removed = this.dirtyItems.delete(itemId)
    if (removed) this.deps.state.setDirty(itemId, false)
    return removed
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
    this.notBefore = 0
    this.requestedDueAt = this.now()
  }

  /**
   * When the next upload is due, for scheduling a poll, or undefined if none is. An upload left to
   * retry at the next poll doesn't count: it waits for the poll's own cadence or backoff.
   */
  get nextDueAt(): number | undefined {
    if (this.dirtyItems.size === 0) return undefined
    const dueAt = Math.min(
      this.debounceDueAt ?? Number.POSITIVE_INFINITY,
      this.maxWaitDueAt ?? Number.POSITIVE_INFINITY,
      this.requestedDueAt ?? Number.POSITIVE_INFINITY,
    )
    return Number.isFinite(dueAt) ? Math.max(dueAt, this.notBefore) : undefined
  }

  /** Whether a poll now should upload the dirty items' snapshots */
  isDue(now = this.now()): boolean {
    if (this.dirtyItems.size === 0) return false
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

  /** Called when the server turned uploads away for the account's quota: none goes up before `time` */
  deferUntil(time: number): void {
    this.notBefore = time
    this.retryAtNextPoll = true
  }

  /**
   * The startup and promotion audit, run once the item records have loaded: queues every flagged item
   * that isn't quarantined, due after `restoredSnapshotDelay` however later edits come, and notes the
   * items quarantined as oversized.
   */
  async restoreFlagged(): Promise<void> {
    if (this.deps.session.isShutdown) return
    try {
      const quarantinedIds = new Set<ItemId>()
      try {
        const recoveryEntries = await this.deps.recoveryManager.listRecoveryItems()
        checkAlive(null, () => !this.deps.session.isShutdown)
        for (const entry of recoveryEntries) {
          quarantinedIds.add(entry.itemId)
          if (entry.kind === 'oversized') {
            this.oversizedItems.add(entry.itemId)
          }
        }
      } catch (recoveryErr) {
        if (isAbortError(recoveryErr)) throw recoveryErr
        log.error('Failed to read manual recovery entries during startup audit', recoveryErr)
      }

      let auditCount = 0
      for (const { itemId, dirty } of this.deps.state.listFlagged()) {
        if (quarantinedIds.has(itemId) || this.dirtyItems.has(itemId)) continue
        this.queue(itemId)
        // Only `snapshotOnly` flagged it, which a dirty flag should have gone with
        if (!dirty) this.deps.state.setDirty(itemId, true)
        auditCount += 1
      }
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

  /**
   * Records a snapshot the server stored: the item leaves the queue if its tick hasn't moved, and its
   * base version rises to the stored one. Without a tick, the item stays dirty: the snapshot wasn't
   * built for its pending edits.
   */
  recordSnapshotSuccess(itemId: ItemId, tick: number | undefined, version?: number): void {
    if (tick !== undefined && this.dirtyItems.get(itemId) === tick) {
      this.removeDirty(itemId)
    }
    if (typeof version === 'number') {
      this.deps.state.raiseBaseVersion(itemId, version)
    }
  }

  /** Returns whether the item wasn't already known to be oversized */
  recordOversized(itemId: ItemId): boolean {
    const isNew = !this.oversizedItems.has(itemId)
    this.oversizedItems.add(itemId)

    // Unconditionally, and with its flag, to avoid infinite retry loops while it's quarantined
    this.removeDirty(itemId)
    return isNew
  }

  clearOversized(itemId: ItemId): void {
    this.oversizedItems.delete(itemId)
  }

  removeDirtyItemIfTickMatches(itemId: ItemId, tick: number): boolean {
    return this.dirtyItems.get(itemId) === tick && this.removeDirty(itemId)
  }

  deleteDirtyItem(itemId: ItemId): boolean {
    if (this.deps.session.isShutdown || !itemId) return false
    const deleted = this.removeDirty(itemId)
    if (this.dirtyItems.size === 0) {
      this.clearDue()
    }
    return deleted
  }

  getDirtyTick(itemId: ItemId): number | undefined {
    return this.dirtyItems.get(itemId)
  }

  isDirty(itemId: ItemId): boolean {
    return this.dirtyItems.has(itemId)
  }

  get dirtyCount(): number {
    return this.dirtyItems.size
  }

  getDirtyItemIds(): ItemId[] {
    return Array.from(this.dirtyItems.keys())
  }

  /** Forgets the session's queue and due times. Called once, as the session stops. */
  clear(): void {
    this.clearDue()
    this.notBefore = 0
    this.dirtyItems.clear()
    this.oversizedItems.clear()
  }
}
