import * as Automerge from '@automerge/automerge/slim'
import { debounce } from 'lodash-es'
import type { ItemId } from '@vault/shared'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import { readItemSyncRecords, updateItemSyncRecords, type ItemSyncRecord } from './stores/itemSyncRecords'
import type { SyncSessionState } from './SyncSessionState'
import { areHeadsEqual, frontierOf } from './utils/automerge'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { AsyncMutex } from '../utils/AsyncMutex'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('ItemSyncState')

/** A field of an item's sync record, which a save writes only if this tab changed it */
type ItemSyncField = Exclude<keyof ItemSyncRecord, 'itemId'>

type ItemState = Omit<ItemSyncRecord, 'itemId'>

export interface ItemSyncStateDeps {
  db: Pick<SyncLogDatabase, 'getAll' | 'update'>
  session: Pick<SyncSessionState, 'isShutdown'>
  now?: () => number
}

/**
 * What this device knows of each item's copy on the server, kept in each item's sync record: its
 * server heads, its base version, whether it owes the server a snapshot (`dirty`), whether only a
 * snapshot can deliver its changes (`snapshotOnly`), and when it first pulled changes no snapshot has
 * confirmed (`pulledAt`). It also holds the session's queue of items owing a snapshot, with a tick for
 * each, which the stored `dirty` flag follows (`markDirty`, `clearDirty`). `SnapshotSchedule` decides
 * only when their uploads are due.
 *
 * Only the account's active tab runs an engine, but a tab that was frozen when another took over can
 * still save after the new session loaded, before it learns it was displaced (see "One active tab" in
 * docs/sync-design.md). So this session's changes are tracked per item and per field, and a save
 * writes only the fields this session changed, in one transaction, keeping the stored values of the
 * rest. A load keeps this session's unsaved values over the stored ones. Base versions only rise
 * (sync rule 8), in memory and against the stored value on save.
 */
export class ItemSyncState {
  private items = new Map<ItemId, ItemState>()
  /** The fields of each item this tab changed and hasn't saved yet */
  private readonly unsaved = new Map<ItemId, Set<ItemSyncField>>()
  /** The fields a save in flight is writing, which a load treats as unsaved until it commits */
  private saving = new Map<ItemId, Set<ItemSyncField>>()
  /**
   * The items queued for a snapshot, each with the tick of its latest marking. It's kept for the
   * session only, apart from the records, so loads and saves never touch it: the stored `dirty` flag
   * carries the queue across sessions (`queueFlagged`).
   */
  private readonly dirtyTicks = new Map<ItemId, number>()
  private lastDirtyTick = 0
  private stopped = false

  private readonly loadGuard = new SingleFlightGuard<void>()
  private readonly saveMutex = new AsyncMutex()

  // Bounded by maxWait, so steady editing still saves. The startup audit needs a saved dirty flag to
  // re-queue an edit whose snapshot never went up.
  private readonly saveDebounced = debounce(
    () => fireAndForget(this.persist(), 'ItemSyncState:persist'),
    SYNC_TIMEOUTS.itemSyncSave,
    { maxWait: SYNC_TIMEOUTS.itemSyncSaveMaxWait },
  )

  constructor(private readonly deps: ItemSyncStateDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private readonly isAlive = () => !this.stopped && !this.deps.session.isShutdown

  /**
   * Loads the stored records, at start. Fields this session hasn't saved yet keep its values, and
   * base versions keep the higher. Concurrent callers share one load. Returns the items the records
   * flag that aren't queued yet, for the startup audit (`queueFlagged`).
   */
  async load(): Promise<ItemId[]> {
    if (!this.isAlive()) return []
    await this.loadGuard.run(() => this.executeLoad())
    return this.listFlagged().filter(itemId => !this.dirtyTicks.has(itemId))
  }

  private async executeLoad(): Promise<void> {
    const records = await readItemSyncRecords(this.deps.db)
    // A session that stopped meanwhile has nothing to load into
    if (!this.isAlive()) return

    const loaded = new Map<ItemId, ItemState>()
    for (const { itemId, ...state } of records) {
      loaded.set(itemId, state)
    }
    const entryOf = (itemId: ItemId): ItemState => {
      let entry = loaded.get(itemId)
      if (!entry) {
        entry = {}
        loaded.set(itemId, entry)
      }
      return entry
    }

    for (const changes of [this.saving, this.unsaved]) {
      for (const [itemId, fields] of changes) {
        const entry = entryOf(itemId)
        const mine = this.items.get(itemId) ?? {}
        for (const field of fields) {
          // Base versions keep the higher, below
          if (field !== 'baseVersion') copyField(entry, mine, field)
        }
      }
    }
    for (const [itemId, mine] of this.items) {
      if (mine.baseVersion !== undefined && mine.baseVersion > (loaded.get(itemId)?.baseVersion ?? 0)) {
        entryOf(itemId).baseVersion = mine.baseVersion
      }
    }

    this.items = loaded
  }

  private entry(itemId: ItemId): ItemState {
    let entry = this.items.get(itemId)
    if (!entry) {
      entry = {}
      this.items.set(itemId, entry)
    }
    return entry
  }

  private markUnsaved(itemId: ItemId, field: ItemSyncField): void {
    let fields = this.unsaved.get(itemId)
    if (!fields) {
      fields = new Set()
      this.unsaved.set(itemId, fields)
    }
    fields.add(field)
    this.saveDebounced()
  }

  private isUnsaved(itemId: ItemId, field: ItemSyncField): boolean {
    return this.unsaved.get(itemId)?.has(field) ?? false
  }

  /** Whether this tab changed the item's field and hasn't saved it yet, such as after a failed save */
  hasUnsaved(itemId: ItemId, field: ItemSyncField): boolean {
    return this.isUnsaved(itemId, field) || (this.saving.get(itemId)?.has(field) ?? false)
  }

  /** The item's server heads, empty when none are known */
  getServerHeads(itemId: ItemId): string[] {
    return this.items.get(itemId)?.serverHeads ?? []
  }

  hasServerHeads(itemId: ItemId): boolean {
    return this.items.get(itemId)?.serverHeads !== undefined
  }

  /** Records heads whose every ancestor is on the server */
  setServerHeads(itemId: ItemId, heads: string[]): void {
    if (this.stopped) return
    const entry = this.entry(itemId)
    if (areHeadsEqual(entry.serverHeads, heads)) return
    entry.serverHeads = heads
    this.markUnsaved(itemId, 'serverHeads')
  }

  /**
   * Records that the server has everything up to `heads` (a snapshot's), without moving the item's
   * server heads back: they become the frontier of both sets in `doc`, which must hold both. Every
   * ancestor of either set is on the server, so the same goes for their frontier. Without a loaded doc
   * to compare them in, existing heads stay, which can only claim less.
   */
  advanceServerHeads(itemId: ItemId, heads: string[], doc: Automerge.Doc<unknown> | undefined): void {
    if (!this.hasServerHeads(itemId)) {
      this.setServerHeads(itemId, heads)
    } else if (doc) {
      this.setServerHeads(itemId, frontierOf(doc, [...this.getServerHeads(itemId), ...heads]))
    }
  }

  /** The server version of the latest snapshot this device uploaded or merged, 0 when there's none */
  getBaseVersion(itemId: ItemId): number {
    return this.items.get(itemId)?.baseVersion ?? 0
  }

  /** Raises the item's base version, which never goes down (sync rule 8) */
  raiseBaseVersion(itemId: ItemId, version: number): void {
    if (this.stopped || version <= this.getBaseVersion(itemId)) return
    this.entry(itemId).baseVersion = version
    this.markUnsaved(itemId, 'baseVersion')
  }

  /** Raises base versions and saves them, logging a failure */
  async importBaseVersions(updates: Array<[ItemId, number]>): Promise<void> {
    for (const [itemId, version] of updates) {
      this.raiseBaseVersion(itemId, version)
    }
    await this.persist()
  }

  /** Every item's base version that's known */
  listBaseVersions(): Map<ItemId, number> {
    const versions = new Map<ItemId, number>()
    for (const [itemId, { baseVersion }] of this.items) {
      if (baseVersion !== undefined) versions.set(itemId, baseVersion)
    }
    return versions
  }

  /**
   * Queues the item for a snapshot and sets its dirty flag: as the session records the acknowledgement of a push (in the same save as the item's server heads), and when sync finds
   * the server lacks what the item holds. Each marking moves the item's tick, so an edit made while an
   * upload is in flight keeps it dirty.
   */
  markDirty(itemId: ItemId): void {
    if (this.stopped) return
    this.queue(itemId)
    this.writeDirtyFlag(itemId, true)
  }

  /**
   * Takes the item out of the queue and clears its flag, if it's queued and, given a tick, that tick
   * hasn't moved since. Returns whether it did. An upload clears them, as does an oversized or failed
   * item's quarantine, or a manifest delete.
   */
  clearDirty(itemId: ItemId, tick?: number): boolean {
    const current = this.dirtyTicks.get(itemId)
    if (current === undefined || (tick !== undefined && current !== tick)) return false
    this.dirtyTicks.delete(itemId)
    this.writeDirtyFlag(itemId, false)
    return true
  }

  private queue(itemId: ItemId): void {
    this.lastDirtyTick += 1
    this.dirtyTicks.set(itemId, this.lastDirtyTick)
  }

  /** Written every time, since this session's copy may be stale */
  private writeDirtyFlag(itemId: ItemId, dirty: boolean): void {
    if (this.stopped) return
    const entry = this.entry(itemId)
    if (dirty) {
      entry.dirty = true
    } else {
      delete entry.dirty
    }
    this.markUnsaved(itemId, 'dirty')
  }

  /**
   * The startup audit, once the records have loaded: queues each of the items that its record flags
   * and isn't queued already. Returns how many it queued.
   *
   * Legacy: `setSnapshotOnly` now sets the dirty flag with `snapshotOnly`, but records saved before it
   * did can be flagged only `snapshotOnly`. Those get their dirty flag here.
   */
  queueFlagged(itemIds: Iterable<ItemId>): number {
    if (this.stopped) return 0
    let count = 0
    for (const itemId of itemIds) {
      const { dirty, snapshotOnly } = this.items.get(itemId) ?? {}
      if (!(dirty || snapshotOnly) || this.dirtyTicks.has(itemId)) continue
      this.queue(itemId)
      if (!dirty) this.writeDirtyFlag(itemId, true)
      count += 1
    }
    return count
  }

  /** The tick of the item's latest marking, or undefined if it isn't queued */
  getDirtyTick(itemId: ItemId): number | undefined {
    return this.dirtyTicks.get(itemId)
  }

  /** Whether the item is queued for a snapshot this session */
  isDirty(itemId: ItemId): boolean {
    return this.dirtyTicks.has(itemId)
  }

  get dirtyCount(): number {
    return this.dirtyTicks.size
  }

  /** The items queued for a snapshot, in the order they were first queued */
  listDirty(): ItemId[] {
    return Array.from(this.dirtyTicks.keys())
  }

  /**
   * Items whose records say they owe the server a snapshot: those flagged dirty, and (legacy) those
   * flagged only `snapshotOnly`, saved before `setSnapshotOnly` set the dirty flag too
   */
  listFlagged(): ItemId[] {
    return Array.from(this.items)
      .filter(([, { dirty, snapshotOnly }]) => dirty || snapshotOnly)
      .map(([itemId]) => itemId)
  }

  /** Whether only a snapshot can deliver the item's changes, so `isCovered` lets it through */
  isSnapshotOnly(itemId: ItemId): boolean {
    return this.items.get(itemId)?.snapshotOnly === true
  }

  /**
   * Snapshot coverage keeps each server snapshot a superset of every one it replaced, and every change
   * in some snapshot. Snapshot uploads stay unconditional and last-write-wins, so this is two rules on
   * the client:
   *
   * - **S1, log before snapshot:** this check lets a snapshot be built only when everything in it is
   *   already in the log.
   * - **S2, backstop at manifest sync:** a device holding changes newer than the server's snapshot
   *   uploads them if nobody else does. `ManifestSyncManager` runs the check, with the unconfirmed
   *   pulls kept here.
   *
   * S1 is synchronous, so that `SnapshotBuilder` can run it in the same section as `Automerge.save`.
   * The one exception has no log to wait for: a change too large for a row (`snapshotOnly`).
   */
  isCovered(itemId: ItemId, doc: Automerge.Doc<unknown>): boolean {
    if (this.isSnapshotOnly(itemId)) return true

    const serverHeads = this.getServerHeads(itemId)
    if (areHeadsEqual(Automerge.getHeads(doc), serverHeads)) return true
    const since = Automerge.hasHeads(doc, serverHeads) ? serverHeads : []
    return Automerge.getChangesSince(doc, since).length === 0
  }

  /**
   * Records that the log refused the item's changes or can't hold one of them, and queues the item
   * for the snapshot that delivers them instead: a snapshot-only item is always dirty, and both flags
   * go in the same save. `SnapshotSchedule.markSnapshotOnly` also makes the snapshot due.
   */
  setSnapshotOnly(itemId: ItemId): void {
    if (this.stopped) return
    this.markDirty(itemId)
    if (this.isSnapshotOnly(itemId)) return
    this.entry(itemId).snapshotOnly = true
    this.markUnsaved(itemId, 'snapshotOnly')
  }

  /** Records a stored snapshot that carried what the log couldn't, which puts the server at its heads */
  confirmSnapshotOnly(itemId: ItemId, heads: string[] | undefined): void {
    if (this.stopped || !this.isSnapshotOnly(itemId)) return
    delete this.entry(itemId).snapshotOnly
    this.markUnsaved(itemId, 'snapshotOnly')
    if (heads && heads.length > 0) {
      this.setServerHeads(itemId, heads)
    }
  }

  /**
   * S2. Starts the day an item's author has to upload a snapshot of pulled changes, keeping the time
   * an item first had them. Resolves once that's saved, and throws if it can't be.
   */
  async recordPulledChanges(itemIds: ItemId[]): Promise<void> {
    if (itemIds.length === 0 || this.stopped) return
    const now = this.now()
    for (const itemId of itemIds) {
      const entry = this.entry(itemId)
      if (entry.pulledAt !== undefined) continue
      entry.pulledAt = now
      this.markUnsaved(itemId, 'pulledAt')
    }
    if (itemIds.some(itemId => this.isUnsaved(itemId, 'pulledAt'))) {
      await this.save()
    }
  }

  /** Items with pulled changes no snapshot has confirmed, with when each first had them */
  listUnconfirmedPulls(): Map<ItemId, number> {
    const pulls = new Map<ItemId, number>()
    for (const [itemId, { pulledAt }] of this.items) {
      if (pulledAt !== undefined) pulls.set(itemId, pulledAt)
    }
    return pulls
  }

  /** S2. A snapshot's heads now contain these items' docs, or they're deleted. Throws if it can't save. */
  async confirmPulledChanges(itemIds: ItemId[]): Promise<void> {
    if (itemIds.length === 0 || this.stopped) return
    for (const itemId of itemIds) {
      delete this.entry(itemId).pulledAt
      this.markUnsaved(itemId, 'pulledAt')
    }
    await this.save()
  }

  /** Saves what this tab changed after the usual delay, such as to retry a save that failed */
  requestSave(): void {
    if (this.stopped) return
    this.saveDebounced()
  }

  /** Starts a pending save now, such as when the page is hidden and may be closed */
  flushPendingSave(): void {
    this.saveDebounced.flush()
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
   * Writes the fields this tab changed, in one transaction, keeping the stored values of the rest.
   * Throws a failure, for callers that must know the records were saved, and the fields stay unsaved.
   */
  async save(): Promise<void> {
    this.saveDebounced.cancel()
    await this.saveMutex.runExclusive(async () => {
      if (this.unsaved.size === 0) return
      const changed = new Map(this.unsaved)
      this.unsaved.clear()
      // The values as they are now, which a load during the write can't change
      const values = new Map(Array.from(changed.keys(), itemId => [itemId, { ...this.items.get(itemId) }]))
      this.saving = changed
      try {
        await updateItemSyncRecords(
          this.deps.db,
          Array.from(changed.keys()),
          record => withChanges(record, values.get(record.itemId)!, changed.get(record.itemId)!),
        )
      } catch (error) {
        for (const [itemId, fields] of changed) {
          const pending = this.unsaved.get(itemId)
          this.unsaved.set(itemId, pending ? new Set([...fields, ...pending]) : fields)
        }
        throw error
      } finally {
        this.saving = new Map()
      }
    })
  }

  /** Saves what this tab changed, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.loadGuard.waitForRunning()
    this.stopped = true
    this.saveDebounced.cancel()
    if (!options?.clearLocalData) {
      await this.persist()
    }
    this.saveDebounced.cancel()
    this.items.clear()
    this.unsaved.clear()
    this.dirtyTicks.clear()
    this.loadGuard.clear()
  }
}

/** Copies one field, removing it from `target` when `source` lacks it */
function copyField(target: ItemState, source: ItemState, field: ItemSyncField): void {
  if (source[field] === undefined) {
    delete target[field]
  } else {
    Object.assign(target, { [field]: source[field] })
  }
}

/** The stored record with this tab's changed fields written over it */
function withChanges(stored: ItemSyncRecord, mine: ItemState, fields: ReadonlySet<ItemSyncField>): ItemSyncRecord {
  const record: ItemSyncRecord = { ...stored }
  for (const field of fields) {
    if (field === 'baseVersion') {
      // Never lowered: a displaced (frozen) session can save after this one raised it
      const baseVersion = Math.max(stored.baseVersion ?? 0, mine.baseVersion ?? 0)
      if (baseVersion > 0) record.baseVersion = baseVersion
    } else if (field === 'pulledAt' && mine.pulledAt !== undefined && stored.pulledAt !== undefined) {
      // Keeps when the item first had them, as a displaced (frozen) session may have recorded them first
      record.pulledAt = Math.min(stored.pulledAt, mine.pulledAt)
    } else {
      copyField(record, mine, field)
    }
  }
  return record
}
