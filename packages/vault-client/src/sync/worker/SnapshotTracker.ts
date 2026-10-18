import { debounce } from 'lodash-es'
import { ItemId } from '@vault/shared'
import { LastModifiedStore, type ItemSyncTimestamps } from './stores/LastModifiedStore'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AsyncMutex } from '../utils/AsyncMutex'
import { checkAlive, isAbortError } from '../utils/abort'
import { RecoveryManager } from './RecoveryManager'
import { fireAndForget } from '../utils/fireAndForget'

export interface SnapshotTrackerOptions {
  accountId: string
  lastModifiedStore: LastModifiedStore
  recoveryManager?: RecoveryManager
  debounceDelayMs?: number
  maxWaitMs?: number
  isLeader?: boolean
  onTriggerPush?: () => void
  isRetryActive?: () => boolean
  onOversizedFound?: (itemId: ItemId) => void
}

export class SnapshotTracker {
  public isShutdown = false
  private isLeader = false
  public isOnline = true
  public readonly dirtyItems = new Map<ItemId, number>()
  public dirtyItemsTick = 0
  public readonly lastModifiedByItemId = new Map<ItemId, number>()
  public readonly lastSnapshotAtByItemId = new Map<ItemId, number>()
  public readonly baseVersionByItemId = new Map<ItemId, number>()

  public debounceTimer: ReturnType<typeof setTimeout> | null = null
  public maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly debounceDelayMs: number
  private readonly maxWaitMs: number

  public readonly loadGuard = new SingleFlightGuard<void>()
  private readonly persistMutex = new AsyncMutex()
  private readonly onTriggerPush?: () => void
  private readonly isRetryActive?: () => boolean
  private readonly onOversizedFound?: (itemId: ItemId) => void
  private readonly recoveryManager?: RecoveryManager
  private readonly lastModifiedStore: LastModifiedStore
  private readonly accountId: string

  public readonly flushDirtyDocumentsToIndexDebounced = debounce(
    () => fireAndForget(this.flushDirtyDocumentsToIndex(), 'SnapshotTracker:flushDirtyDocumentsToIndex'),
    1000,
  )

  public readonly saveLastModifiedDebounced = debounce(
    () => fireAndForget(this.persistLastModified(), 'SnapshotTracker:persistLastModified'),
    1000,
  )

  constructor(options: SnapshotTrackerOptions) {
    this.accountId = options.accountId
    this.lastModifiedStore = options.lastModifiedStore
    this.recoveryManager = options.recoveryManager ?? (options.accountId ? new RecoveryManager({ accountId: options.accountId }) : undefined)
    this.debounceDelayMs = options.debounceDelayMs ?? 30_000
    this.maxWaitMs = options.maxWaitMs ?? 5 * 60 * 1000
    this.isLeader = options.isLeader ?? false
    this.onTriggerPush = options.onTriggerPush
    this.isRetryActive = options.isRetryActive
    this.onOversizedFound = options.onOversizedFound
  }

  get isOperational(): boolean {
    return !this.isShutdown && this.isLeader && this.isOnline
  }

  get leader(): boolean {
    return this.isLeader
  }

  setLeader(isLeader: boolean): void {
    if (this.isShutdown || this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader

    if (isLeader) {
      if (this.dirtyItems.size > 0) {
        this.scheduleDebouncedSnapshotPush()
      }
    } else {
      this.clearDebounceTimers()
    }
  }

  setOnline(isOnline: boolean): void {
    this.isOnline = isOnline
  }

  markItemDirty(itemId: ItemId, customDebounceDelayMs?: number): void {
    if (this.isShutdown || !itemId) return
    this.dirtyItemsTick += 1
    this.dirtyItems.set(itemId, this.dirtyItemsTick)
    this.flushDirtyDocumentsToIndexDebounced()
    this.scheduleDebouncedSnapshotPush(customDebounceDelayMs)
  }

  getLastSnapshotAt(itemId: ItemId): number | undefined {
    return this.lastSnapshotAtByItemId.get(itemId)
  }

  getLocalModifiedAt(itemId: ItemId): number | undefined {
    return this.lastModifiedByItemId.get(itemId)
  }

  scheduleDebouncedSnapshotPush(customDelayMs?: number): void {
    if (!this.isOperational) return
    if (this.isRetryActive?.()) return

    const delay = typeof customDelayMs === 'number' ? customDelayMs : this.debounceDelayMs
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }

    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = setTimeout(() => {
        this.clearDebounceTimers()
        this.onTriggerPush?.()
      }, this.maxWaitMs)
    }

    this.debounceTimer = setTimeout(() => {
      this.clearDebounceTimers()
      this.onTriggerPush?.()
    }, delay)
  }

  clearDebounceTimers(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.maxWaitTimer !== null) {
      clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
  }

  updateLastModifiedForDirtyItems(): void {
    const dirtyItemIds = Array.from(this.dirtyItems.keys())
    if (dirtyItemIds.length === 0) {
      return
    }

    const timestamp = Date.now()
    for (const itemId of dirtyItemIds) {
      this.lastModifiedByItemId.set(itemId, timestamp)
    }
  }

  async flushDirtyDocumentsToIndex(): Promise<void> {
    this.updateLastModifiedForDirtyItems()
    this.saveLastModifiedDebounced()
  }

  async loadLastModified(): Promise<{ auditCount: number; oversizedItemIds: Set<ItemId> }> {
    if (this.isShutdown) return { auditCount: 0, oversizedItemIds: new Set() }
    let result = { auditCount: 0, oversizedItemIds: new Set<ItemId>() }
    await this.loadGuard.run(async () => {
      result = await this.executeLoadLastModified()
    })
    return result
  }

  private async executeLoadLastModified(): Promise<{ auditCount: number; oversizedItemIds: Set<ItemId> }> {
    const oversizedItemIds = new Set<ItemId>()
    let auditCount = 0

    try {
      checkAlive(null, () => !this.isShutdown)
      const stored = await this.lastModifiedStore.loadTimestamps()
      checkAlive(null, () => !this.isShutdown)

      if (stored && Array.isArray(stored)) {
        for (const [itemId, ts] of stored) {
          const existingLocalMod = this.lastModifiedByItemId.get(itemId) ?? 0
          const lastSnap = typeof ts.lastSnapshotAt === 'number' ? ts.lastSnapshotAt : 0
          this.lastModifiedByItemId.set(itemId, Math.max(existingLocalMod, ts.localModifiedAt, lastSnap))
          if (typeof ts.lastSnapshotAt === 'number') {
            const existingLastSnap = this.lastSnapshotAtByItemId.get(itemId) ?? 0
            this.lastSnapshotAtByItemId.set(itemId, Math.max(existingLastSnap, ts.lastSnapshotAt))
          }
          if (typeof ts.baseVersion === 'number') {
            const existingVersion = this.baseVersionByItemId.get(itemId) ?? 0
            this.baseVersionByItemId.set(itemId, Math.max(existingVersion, ts.baseVersion))
          }
        }
      }

      const quarantinedIds = new Set<ItemId>()
      if (this.accountId && this.recoveryManager) {
        try {
          const recoveryEntries = await this.recoveryManager.listRecoveryItems(this.accountId)
          checkAlive(null, () => !this.isShutdown)
          for (const entry of recoveryEntries) {
            quarantinedIds.add(entry.itemId)
            if (entry.kind === 'oversized') {
              oversizedItemIds.add(entry.itemId)
              this.onOversizedFound?.(entry.itemId)
            }
          }
        } catch (recoveryErr) {
          if (isAbortError(recoveryErr)) throw recoveryErr
          console.error('[SnapshotTracker] Failed to read manual recovery entries during startup audit', recoveryErr)
        }
      }

      checkAlive(null, () => !this.isShutdown)

      // Startup & Promotion Dirty Audit: Re-enqueue un-snapshotted items (excluding quarantined items)
      for (const [itemId, localMod] of this.lastModifiedByItemId.entries()) {
        if (quarantinedIds.has(itemId)) {
          continue
        }
        const lastSnap = this.lastSnapshotAtByItemId.get(itemId) ?? 0
        if (localMod > lastSnap) {
          if (!this.dirtyItems.has(itemId)) {
            this.dirtyItemsTick += 1
            this.dirtyItems.set(itemId, this.dirtyItemsTick)
            auditCount += 1
          }
        }
      }
      if (auditCount > 0) {
        console.info(`[SnapshotTracker] Startup audit restored ${auditCount} un-snapshotted items to dirty queue`)
        this.scheduleDebouncedSnapshotPush()
      }
    } catch (error) {
      if (isAbortError(error) || this.isShutdown) return { auditCount: 0, oversizedItemIds }
      console.error('[SnapshotTracker] Failed to load lastModified timestamps', error)
    }

    return { auditCount, oversizedItemIds }
  }

  /**
   * Merges this tab's timestamps into the stored ones, keeping the later value of each. Every tab of
   * the account writes here, and a tab's maps can be older than the store (a follower only loads them
   * at startup), so writing them over the store would lose the leader's progress.
   */
  async persistLastModified(): Promise<void> {
    await this.persistMutex.runExclusive(async () => {
      try {
        const merged = new Map<ItemId, ItemSyncTimestamps>(await this.lastModifiedStore.loadTimestamps() ?? [])
        const allItemIds = new Set([
          ...this.lastModifiedByItemId.keys(),
          ...this.lastSnapshotAtByItemId.keys(),
          ...this.baseVersionByItemId.keys(),
        ])
        for (const itemId of allItemIds) {
          const stored = merged.get(itemId)
          const lastSnapshotAt = this.lastSnapshotAtByItemId.get(itemId)
          merged.set(itemId, {
            localModifiedAt: Math.max(stored?.localModifiedAt ?? 0, this.lastModifiedByItemId.get(itemId) ?? 0),
            lastSnapshotAt: lastSnapshotAt === undefined && stored?.lastSnapshotAt === undefined
              ? undefined
              : Math.max(stored?.lastSnapshotAt ?? 0, lastSnapshotAt ?? 0),
            baseVersion: Math.max(stored?.baseVersion ?? 0, this.baseVersionByItemId.get(itemId) ?? 0),
          })
        }
        await this.lastModifiedStore.saveTimestamps(Array.from(merged.entries()))
      } catch (error) {
        console.error('[SnapshotTracker] Failed to save lastModified timestamps', error)
      }
    })
  }

  recordSnapshotSuccess(itemId: ItemId, modified: number, tick: number, version?: number): void {
    if (this.dirtyItems.get(itemId) === tick) {
      this.dirtyItems.delete(itemId)
    }
    this.lastSnapshotAtByItemId.set(itemId, modified)
    const currentLocalMod = this.lastModifiedByItemId.get(itemId) ?? 0
    this.lastModifiedByItemId.set(
      itemId,
      Math.max(currentLocalMod, modified),
    )
    if (typeof version === 'number') {
      const currentVersion = this.baseVersionByItemId.get(itemId) ?? 0
      this.baseVersionByItemId.set(itemId, Math.max(currentVersion, version))
    }
    this.saveLastModifiedDebounced()
  }

  recordOversized(itemId: ItemId, modified: number): void {
    // Unconditionally remove from dirtyItems to avoid infinite retry loops
    this.dirtyItems.delete(itemId)

    // Advance lastSnapshotAt to localModifiedAt to prevent startup audit / sync loops while quarantined
    const localMod = this.lastModifiedByItemId.get(itemId) ?? modified
    this.lastSnapshotAtByItemId.set(itemId, localMod)
    this.saveLastModifiedDebounced()
  }

  removeDirtyItemIfTickMatches(itemId: ItemId, tick: number): boolean {
    if (this.dirtyItems.get(itemId) === tick) {
      this.dirtyItems.delete(itemId)
      return true
    }
    return false
  }

  deleteDirtyItem(itemId: ItemId): boolean {
    if (this.isShutdown || !itemId) return false
    const deleted = this.dirtyItems.delete(itemId)
    const localMod = this.lastModifiedByItemId.get(itemId)
    const lastSnap = this.lastSnapshotAtByItemId.get(itemId) ?? 0
    if (localMod !== undefined && localMod > lastSnap) {
      this.lastSnapshotAtByItemId.set(itemId, localMod)
      this.saveLastModifiedDebounced()
    }
    if (this.dirtyItems.size === 0) {
      this.clearDebounceTimers()
    }
    return deleted
  }

  hasDirty(itemId: ItemId): boolean {
    return this.dirtyItems.has(itemId)
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
    const allIds = new Set([...this.lastModifiedByItemId.keys(), ...this.lastSnapshotAtByItemId.keys()])
    for (const id of allIds) {
      const localMod = this.lastModifiedByItemId.get(id) ?? 0
      const lastSnap = this.lastSnapshotAtByItemId.get(id) ?? 0
      result.push([id, Math.max(localMod, lastSnap)])
    }
    return result
  }

  async importLastModified(data: [ItemId, number][]): Promise<void> {
    for (const [itemId, mod] of data) {
      if (this.dirtyItems.has(itemId)) {
        // Unsaved local edit: keep it pending upload
        const existingLocalMod = this.lastModifiedByItemId.get(itemId) ?? 0
        this.lastModifiedByItemId.set(itemId, Math.max(existingLocalMod, mod))
      } else {
        this.lastModifiedByItemId.set(itemId, mod)
        this.lastSnapshotAtByItemId.set(itemId, mod)
      }
    }
    await this.persistLastModified()
  }

  exportItemVersions(): Map<ItemId, { baseVersion: number; isDirty: boolean }> {
    const result = new Map<ItemId, { baseVersion: number; isDirty: boolean }>()
    const allIds = new Set([
      ...this.lastModifiedByItemId.keys(),
      ...this.lastSnapshotAtByItemId.keys(),
      ...this.baseVersionByItemId.keys(),
      ...this.dirtyItems.keys(),
    ])
    for (const id of allIds) {
      result.set(id, {
        baseVersion: this.baseVersionByItemId.get(id) ?? 0,
        isDirty: this.dirtyItems.has(id),
      })
    }
    return result
  }

  async importVersions(updates: Array<[ItemId, number]>): Promise<void> {
    for (const [itemId, version] of updates) {
      const currentVersion = this.baseVersionByItemId.get(itemId) ?? 0
      this.baseVersionByItemId.set(itemId, Math.max(currentVersion, version))
    }
    await this.persistLastModified()
  }

  clear(): void {
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()
    this.dirtyItems.clear()
    this.lastModifiedByItemId.clear()
    this.lastSnapshotAtByItemId.clear()
    this.baseVersionByItemId.clear()
    this.loadGuard.clear()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    if (this.isShutdown) return
    this.isShutdown = true
    this.isLeader = false

    await this.loadGuard.waitForRunning()
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()

    if (!options?.clearLocalData) {
      if (this.dirtyItems.size > 0) {
        this.updateLastModifiedForDirtyItems()
      }
      await this.persistLastModified()
    }

    this.clear()
  }
}
