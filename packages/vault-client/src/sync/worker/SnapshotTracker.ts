import { debounce } from 'lodash-es'
import { ItemId } from '@vault/shared'
import { LastModifiedStore, type ItemSyncTimestamps } from './stores/LastModifiedStore'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AsyncMutex } from '../utils/AsyncMutex'
import { RetryTimer } from '../utils/RetryTimer'
import { checkAlive, isAbortError } from '../utils/abort'
import type { RecoveryManager } from './RecoveryManager'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'
import type { SyncSessionState } from './SyncSessionState'

const log = createLogger('SnapshotTracker')

export interface SnapshotTrackerOptions {
  lastModifiedStore: LastModifiedStore
  recoveryManager: RecoveryManager
  debounceDelayMs?: number
  maxWaitMs?: number
  /** Only the leader uploads snapshots, and only while online */
  session: SyncSessionState
  onTriggerPush?: () => void
  isRetryActive?: () => boolean
}

/**
 * What the tracker knows of an item's {@link ItemSyncTimestamps}. A field is unset until something
 * records it, which keeps an item known only by its version out of the timestamp export.
 */
type TrackedTimestamps = Partial<ItemSyncTimestamps>

export class SnapshotTracker {
  private readonly session: SyncSessionState
  private readonly dirtyItems = new Map<ItemId, number>()
  private dirtyItemsTick = 0
  private readonly timestampsByItemId = new Map<ItemId, TrackedTimestamps>()
  /** Items quarantined as too large to upload, so the warning is given only once */
  private readonly oversizedItems = new Set<ItemId>()

  private readonly debounceTimer = new RetryTimer()
  private readonly maxWaitTimer = new RetryTimer()
  private readonly debounceDelayMs: number
  private readonly maxWaitMs: number

  private readonly loadGuard = new SingleFlightGuard<void>()
  private readonly persistMutex = new AsyncMutex()
  private readonly onTriggerPush?: () => void
  private readonly isRetryActive?: () => boolean
  private readonly recoveryManager: RecoveryManager
  private readonly lastModifiedStore: LastModifiedStore

  // Bounded by maxWait, so steady editing still saves. The startup audit needs a saved localModifiedAt
  // to re-queue an edit whose snapshot never went up.
  private readonly saveLastModifiedDebounced = debounce(
    () => fireAndForget(this.persistLastModified(), 'SnapshotTracker:persistLastModified'),
    1000,
    { maxWait: 5000 },
  )

  constructor(options: SnapshotTrackerOptions) {
    this.lastModifiedStore = options.lastModifiedStore
    this.recoveryManager = options.recoveryManager
    this.debounceDelayMs = options.debounceDelayMs ?? 30_000
    this.maxWaitMs = options.maxWaitMs ?? 5 * 60 * 1000
    this.session = options.session
    this.onTriggerPush = options.onTriggerPush
    this.isRetryActive = options.isRetryActive
  }

  /** Schedules the pending uploads when this tab becomes the leader, and cancels them when it stops being one */
  onLeaderChange(): void {
    if (this.session.isShutdown) return
    if (this.session.isLeader) {
      if (this.dirtyItems.size > 0) {
        this.scheduleDebouncedSnapshotPush()
      }
    } else {
      this.clearDebounceTimers()
    }
  }

  markItemDirty(itemId: ItemId, customDebounceDelayMs?: number): void {
    if (this.session.isShutdown || !itemId) return
    this.dirtyItemsTick += 1
    this.dirtyItems.set(itemId, this.dirtyItemsTick)
    this.timestamps(itemId).localModifiedAt = Date.now()
    this.saveLastModifiedDebounced()
    this.scheduleDebouncedSnapshotPush(customDebounceDelayMs)
  }

  /** The item's tracked timestamps, created empty if it has none */
  private timestamps(itemId: ItemId): TrackedTimestamps {
    let entry = this.timestampsByItemId.get(itemId)
    if (!entry) {
      entry = {}
      this.timestampsByItemId.set(itemId, entry)
    }
    return entry
  }

  scheduleDebouncedSnapshotPush(customDelayMs?: number): void {
    if (!this.session.isOperational) return
    if (this.isRetryActive?.()) return

    const trigger = () => {
      this.clearDebounceTimers()
      this.onTriggerPush?.()
    }
    if (!this.maxWaitTimer.isPending) {
      this.maxWaitTimer.schedule(this.maxWaitMs, trigger)
    }
    this.debounceTimer.schedule(customDelayMs ?? this.debounceDelayMs, trigger)
  }

  clearDebounceTimers(): void {
    this.debounceTimer.cancel()
    this.maxWaitTimer.cancel()
  }

  updateLastModifiedForDirtyItems(): void {
    const dirtyItemIds = Array.from(this.dirtyItems.keys())
    if (dirtyItemIds.length === 0) {
      return
    }

    const timestamp = Date.now()
    for (const itemId of dirtyItemIds) {
      this.timestamps(itemId).localModifiedAt = timestamp
    }
  }

  /** Starts a pending save of the timestamps now, such as when the page is hidden and may be closed */
  flushPendingSave(): void {
    this.saveLastModifiedDebounced.flush()
  }

  /** Loads the stored timestamps and the items quarantined as oversized */
  async loadLastModified(): Promise<void> {
    if (this.session.isShutdown) return
    return this.loadGuard.run(() => this.executeLoadLastModified())
  }

  private async executeLoadLastModified(): Promise<void> {
    try {
      checkAlive(null, () => !this.session.isShutdown)
      const stored = await this.lastModifiedStore.loadTimestamps()
      checkAlive(null, () => !this.session.isShutdown)

      if (stored && Array.isArray(stored)) {
        for (const [itemId, ts] of stored) {
          const entry = this.timestamps(itemId)
          entry.localModifiedAt = Math.max(entry.localModifiedAt ?? 0, ts.localModifiedAt, ts.lastSnapshotAt ?? 0)
          if (typeof ts.lastSnapshotAt === 'number') {
            entry.lastSnapshotAt = Math.max(entry.lastSnapshotAt ?? 0, ts.lastSnapshotAt)
          }
          if (typeof ts.baseVersion === 'number') {
            entry.baseVersion = Math.max(entry.baseVersion ?? 0, ts.baseVersion)
          }
        }
      }

      const quarantinedIds = new Set<ItemId>()
      try {
        const recoveryEntries = await this.recoveryManager.listRecoveryItems()
        checkAlive(null, () => !this.session.isShutdown)
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

      checkAlive(null, () => !this.session.isShutdown)

      // Startup & Promotion Dirty Audit: Re-enqueue un-snapshotted items (excluding quarantined items)
      let auditCount = 0
      for (const [itemId, { localModifiedAt, lastSnapshotAt }] of this.timestampsByItemId) {
        if (quarantinedIds.has(itemId) || localModifiedAt === undefined) {
          continue
        }
        if (localModifiedAt > (lastSnapshotAt ?? 0) && !this.dirtyItems.has(itemId)) {
          this.dirtyItemsTick += 1
          this.dirtyItems.set(itemId, this.dirtyItemsTick)
          auditCount += 1
        }
      }
      if (auditCount > 0) {
        log.info(`Startup audit restored ${auditCount} un-snapshotted items to dirty queue`)
        this.scheduleDebouncedSnapshotPush()
      }
    } catch (error) {
      if (isAbortError(error) || this.session.isShutdown) return
      log.error('Failed to load lastModified timestamps', error)
    }
  }

  /**
   * Merges this tab's timestamps into the stored ones, keeping the later value of each. Every tab of
   * the account writes here, and a tab's maps can be older than the store (a follower only loads them
   * at startup), so writing them over the store would lose the leader's progress. Logs a failure.
   */
  async persistLastModified(): Promise<void> {
    try {
      await this.saveLastModified()
    } catch (error) {
      log.error('Failed to save lastModified timestamps', error)
    }
  }

  /** Like `persistLastModified`, but throws a failure, for callers that must know the timestamps were saved */
  async saveLastModified(): Promise<void> {
    await this.persistMutex.runExclusive(async () => {
      const merged = new Map<ItemId, ItemSyncTimestamps>(await this.lastModifiedStore.loadTimestamps() ?? [])
      for (const [itemId, local] of this.timestampsByItemId) {
        const stored = merged.get(itemId)
        merged.set(itemId, {
          localModifiedAt: Math.max(stored?.localModifiedAt ?? 0, local.localModifiedAt ?? 0),
          lastSnapshotAt: local.lastSnapshotAt === undefined && stored?.lastSnapshotAt === undefined
            ? undefined
            : Math.max(stored?.lastSnapshotAt ?? 0, local.lastSnapshotAt ?? 0),
          baseVersion: Math.max(stored?.baseVersion ?? 0, local.baseVersion ?? 0),
        })
      }
      await this.lastModifiedStore.saveTimestamps(Array.from(merged.entries()))
    })
  }

  /** Without a tick, the item stays dirty: the snapshot wasn't built for its pending edits */
  recordSnapshotSuccess(itemId: ItemId, modified: number, tick: number | undefined, version?: number): void {
    if (tick !== undefined && this.dirtyItems.get(itemId) === tick) {
      this.dirtyItems.delete(itemId)
    }
    const entry = this.timestamps(itemId)
    entry.lastSnapshotAt = modified
    entry.localModifiedAt = Math.max(entry.localModifiedAt ?? 0, modified)
    if (typeof version === 'number') {
      entry.baseVersion = Math.max(entry.baseVersion ?? 0, version)
    }
    this.saveLastModifiedDebounced()
  }

  /** Returns whether the item wasn't already known to be oversized */
  recordOversized(itemId: ItemId, modified: number): boolean {
    const isNew = !this.oversizedItems.has(itemId)
    this.oversizedItems.add(itemId)

    // Unconditionally remove from dirtyItems to avoid infinite retry loops
    this.dirtyItems.delete(itemId)

    // Advance lastSnapshotAt to localModifiedAt to prevent startup audit / sync loops while quarantined
    const entry = this.timestamps(itemId)
    entry.lastSnapshotAt = entry.localModifiedAt ?? modified
    this.saveLastModifiedDebounced()
    return isNew
  }

  clearOversized(itemId: ItemId): void {
    this.oversizedItems.delete(itemId)
  }

  removeDirtyItemIfTickMatches(itemId: ItemId, tick: number): boolean {
    if (this.dirtyItems.get(itemId) === tick) {
      this.dirtyItems.delete(itemId)
      return true
    }
    return false
  }

  deleteDirtyItem(itemId: ItemId): boolean {
    if (this.session.isShutdown || !itemId) return false
    const deleted = this.dirtyItems.delete(itemId)
    const entry = this.timestampsByItemId.get(itemId)
    if (entry?.localModifiedAt !== undefined && entry.localModifiedAt > (entry.lastSnapshotAt ?? 0)) {
      entry.lastSnapshotAt = entry.localModifiedAt
      this.saveLastModifiedDebounced()
    }
    if (this.dirtyItems.size === 0) {
      this.clearDebounceTimers()
    }
    return deleted
  }

  getDirtyTick(itemId: ItemId): number | undefined {
    return this.dirtyItems.get(itemId)
  }

  get dirtyCount(): number {
    return this.dirtyItems.size
  }

  getDirtyItemIds(): ItemId[] {
    return Array.from(this.dirtyItems.keys())
  }

  exportLastModified(): [ItemId, number][] {
    const result: [ItemId, number][] = []
    for (const [id, { localModifiedAt, lastSnapshotAt }] of this.timestampsByItemId) {
      if (localModifiedAt !== undefined || lastSnapshotAt !== undefined) {
        result.push([id, Math.max(localModifiedAt ?? 0, lastSnapshotAt ?? 0)])
      }
    }
    return result
  }

  async importLastModified(data: [ItemId, number][]): Promise<void> {
    for (const [itemId, mod] of data) {
      const entry = this.timestamps(itemId)
      if (this.dirtyItems.has(itemId)) {
        // Unsaved local edit: keep it pending upload
        entry.localModifiedAt = Math.max(entry.localModifiedAt ?? 0, mod)
      } else {
        entry.localModifiedAt = mod
        entry.lastSnapshotAt = mod
      }
    }
    await this.persistLastModified()
  }

  exportItemVersions(): Map<ItemId, { baseVersion: number; isDirty: boolean }> {
    const result = new Map<ItemId, { baseVersion: number; isDirty: boolean }>()
    for (const id of new Set([...this.timestampsByItemId.keys(), ...this.dirtyItems.keys()])) {
      result.set(id, {
        baseVersion: this.timestampsByItemId.get(id)?.baseVersion ?? 0,
        isDirty: this.dirtyItems.has(id),
      })
    }
    return result
  }

  async importVersions(updates: Array<[ItemId, number]>): Promise<void> {
    for (const [itemId, version] of updates) {
      const entry = this.timestamps(itemId)
      entry.baseVersion = Math.max(entry.baseVersion ?? 0, version)
    }
    await this.persistLastModified()
  }

  clear(): void {
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()
    this.dirtyItems.clear()
    this.timestampsByItemId.clear()
    this.oversizedItems.clear()
    this.loadGuard.clear()
  }

  /** Saves the timestamps, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.loadGuard.waitForRunning()
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()

    if (!options?.clearLocalData) {
      if (this.dirtyItems.size > 0) {
        this.updateLastModifiedForDirtyItems()
      }
      await this.persistLastModified()
    }

    this.clear()
  }
}
