import { debounce } from 'lodash-es'
import type { ItemId } from '@vault/shared'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import { readItemSyncRecords, updateItemSyncRecords, type ItemSyncRecord } from './stores/itemSyncRecords'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AsyncMutex } from '../utils/AsyncMutex'
import { checkAlive, isAbortError } from '../utils/abort'
import type { RecoveryManager } from './RecoveryManager'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('SnapshotTracker')

export interface SnapshotTrackerOptions {
  /** Holds each item's sync record, where its dirty flag and base version are kept */
  db: Pick<SyncLogDatabase, 'getAll' | 'update'>
  recoveryManager: RecoveryManager
  debounceDelayMs?: number
  maxWaitMs?: number
  session: SyncSessionState
  /** Called when snapshots may be due sooner than before, so the next poll can be brought forward */
  onDueChanged?: () => void
  now?: () => number
}

/**
 * Tracks the items that owe the server a snapshot, and each item's base version.
 *
 * Within a session the dirty items are counted with ticks, so an edit made while an upload is in
 * flight keeps the item dirty. Across sessions each item's sync record carries a `dirty` flag, set
 * when the item is marked and cleared when it stops being dirty, and the startup audit re-queues every
 * flagged item. Every tab marks items, but only the leader clears them, and each save writes only the
 * items this tab changed, in one transaction.
 */
export class SnapshotTracker {
  private readonly dirtyItems = new Map<ItemId, number>()
  private dirtyItemsTick = 0
  private readonly baseVersions = new Map<ItemId, number>()
  /** Items whose dirty flag or base version this tab hasn't saved yet */
  private readonly unsaved = new Set<ItemId>()
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

  private readonly loadGuard = new SingleFlightGuard<void>()
  private readonly saveMutex = new AsyncMutex()

  // Bounded by maxWait, so steady editing still saves. The startup audit needs a saved flag to
  // re-queue an edit whose snapshot never went up.
  private readonly saveDebounced = debounce(
    () => fireAndForget(this.persist(), 'SnapshotTracker:persist'),
    SYNC_TIMEOUTS.snapshotTimestampsSave,
    { maxWait: SYNC_TIMEOUTS.snapshotTimestampsSaveMaxWait },
  )

  constructor(private readonly deps: SnapshotTrackerOptions) {
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
    this.dirtyItemsTick += 1
    this.dirtyItems.set(itemId, this.dirtyItemsTick)
    this.markUnsaved(itemId)
    this.scheduleDue(customDebounceDelayMs)
  }

  private markUnsaved(itemId: ItemId): void {
    this.unsaved.add(itemId)
    this.saveDebounced()
  }

  /** Drops the item from the dirty items, clearing its flag */
  private removeDirty(itemId: ItemId): boolean {
    const removed = this.dirtyItems.delete(itemId)
    if (removed) this.markUnsaved(itemId)
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

  /** Starts a pending save now, such as when the page is hidden and may be closed */
  flushPendingSave(): void {
    this.saveDebounced.flush()
  }

  /** Loads the stored records and the items quarantined as oversized */
  async load(): Promise<void> {
    if (this.deps.session.isShutdown) return
    return this.loadGuard.run(() => this.executeLoad())
  }

  private async executeLoad(): Promise<void> {
    try {
      checkAlive(null, () => !this.deps.session.isShutdown)
      const records = await readItemSyncRecords(this.deps.db)
      checkAlive(null, () => !this.deps.session.isShutdown)

      const flagged: ItemId[] = []
      for (const { itemId, baseVersion, dirty } of records) {
        if (typeof baseVersion === 'number') {
          this.raiseBaseVersion(itemId, baseVersion)
        }
        if (dirty) flagged.push(itemId)
      }

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

      checkAlive(null, () => !this.deps.session.isShutdown)

      // Startup and promotion audit: re-queue flagged items, except quarantined ones
      let auditCount = 0
      for (const itemId of flagged) {
        if (quarantinedIds.has(itemId) || this.dirtyItems.has(itemId)) continue
        this.dirtyItemsTick += 1
        this.dirtyItems.set(itemId, this.dirtyItemsTick)
        auditCount += 1
      }
      if (auditCount > 0) {
        log.info(`Startup audit restored ${auditCount} un-snapshotted items to dirty queue`)
        // Due soon, however later edits come: a fresh debounce could put them off session after session
        this.scheduleDue(Math.min(SYNC_TIMEOUTS.restoredSnapshotDelay, this.debounceDelayMs))
      }
    } catch (error) {
      if (isAbortError(error) || this.deps.session.isShutdown) return
      log.error('Failed to load item sync records', error)
    }
  }

  /** Like `save`, but logs a failure */
  private async persist(): Promise<void> {
    try {
      await this.save()
    } catch (error) {
      log.error('Failed to save item sync records', error)
    }
  }

  /**
   * Writes the dirty flag and base version of each item this tab changed, in one transaction. Base
   * versions keep the higher of this tab's and the stored one, since a tab can have loaded before the
   * leader raised it. Throws a failure, for callers that must know the records were saved, and the
   * items stay unsaved.
   */
  async save(): Promise<void> {
    this.saveDebounced.cancel()
    await this.saveMutex.runExclusive(async () => {
      if (this.unsaved.size === 0) return
      const changed = Array.from(this.unsaved)
      this.unsaved.clear()
      try {
        await updateItemSyncRecords(this.deps.db, changed, record => this.withTrackedState(record))
      } catch (error) {
        for (const itemId of changed) {
          this.unsaved.add(itemId)
        }
        throw error
      }
    })
  }

  private withTrackedState(stored: ItemSyncRecord): ItemSyncRecord {
    const { dirty: _dirty, ...record } = stored
    const baseVersion = Math.max(record.baseVersion ?? 0, this.getBaseVersion(record.itemId))
    return {
      ...record,
      ...(baseVersion > 0 ? { baseVersion } : {}),
      ...(this.dirtyItems.has(record.itemId) ? { dirty: true } : {}),
    }
  }

  /** Without a tick, the item stays dirty: the snapshot wasn't built for its pending edits */
  recordSnapshotSuccess(itemId: ItemId, tick: number | undefined, version?: number): void {
    if (tick !== undefined && this.dirtyItems.get(itemId) === tick) {
      this.dirtyItems.delete(itemId)
    }
    if (typeof version === 'number') {
      this.raiseBaseVersion(itemId, version)
    }
    this.markUnsaved(itemId)
  }

  private raiseBaseVersion(itemId: ItemId, version: number): void {
    this.baseVersions.set(itemId, Math.max(this.getBaseVersion(itemId), version))
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

  getBaseVersion(itemId: ItemId): number {
    return this.baseVersions.get(itemId) ?? 0
  }

  get dirtyCount(): number {
    return this.dirtyItems.size
  }

  getDirtyItemIds(): ItemId[] {
    return Array.from(this.dirtyItems.keys())
  }

  exportItemVersions(): Map<ItemId, { baseVersion: number; isDirty: boolean }> {
    const result = new Map<ItemId, { baseVersion: number; isDirty: boolean }>()
    for (const id of new Set([...this.baseVersions.keys(), ...this.dirtyItems.keys()])) {
      result.set(id, {
        baseVersion: this.getBaseVersion(id),
        isDirty: this.dirtyItems.has(id),
      })
    }
    return result
  }

  async importVersions(updates: Array<[ItemId, number]>): Promise<void> {
    for (const [itemId, version] of updates) {
      this.raiseBaseVersion(itemId, version)
      this.unsaved.add(itemId)
    }
    await this.persist()
  }

  clear(): void {
    this.clearDue()
    this.notBefore = 0
    this.saveDebounced.cancel()
    this.dirtyItems.clear()
    this.baseVersions.clear()
    this.unsaved.clear()
    this.oversizedItems.clear()
    this.loadGuard.clear()
  }

  /** Saves what this tab changed, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.loadGuard.waitForRunning()
    this.clearDue()
    this.saveDebounced.cancel()

    if (!options?.clearLocalData) {
      await this.persist()
    }

    this.clear()
  }
}
