import * as Automerge from '@automerge/automerge/slim'
import { debounce } from 'lodash-es'
import type { ItemId } from '@vault/shared'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import { readItemSyncRecords, updateItemSyncRecords, type ItemSyncRecord } from './stores/itemSyncRecords'
import type { SyncSessionState } from './SyncSessionState'
import { areHeadsEqual } from './utils/automerge'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { AsyncMutex } from '../utils/AsyncMutex'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('ItemSyncState')

/** A field of an item's sync record, which a save writes only if this tab changed it */
type ItemSyncField = Exclude<keyof ItemSyncRecord, 'itemId'>

type ItemState = Omit<ItemSyncRecord, 'itemId'>

/**
 * A record of the store unconfirmed pulls were kept in before they moved into the items' records.
 * It's read only to migrate them, and can go a release after that.
 */
interface LegacyUnconfirmedPull {
  itemId: ItemId
  firstSeenAt: number
}

export interface ItemSyncStateDeps {
  db: Pick<SyncLogDatabase, 'getAll' | 'update' | 'delete'>
  session: Pick<SyncSessionState, 'isShutdown'>
  now?: () => number
}

/**
 * What this device knows of each item's copy on the server, kept in each item's sync record: its
 * server heads, its base version, whether it owes the server a snapshot (`dirty`), whether only a
 * snapshot can deliver its changes (`snapshotOnly`), and when it first pulled changes no snapshot has
 * confirmed (`pulledAt`).
 *
 * Every tab holds a copy, but they don't all know the same: only the leader records server heads,
 * marks items dirty (as it records an acknowledged push), uploads and pulls, and a tab that has just
 * stopped leading can still save after the new leader loaded. Followers read the records, to count
 * what's still to sync. So this tab's changes are tracked per item and per field,
 * and a save writes only the fields this tab changed, in one transaction, keeping the stored values
 * of the rest. A load keeps this tab's unsaved values over the stored ones. Base versions only rise
 * (sync rule 8), in memory and against the stored value on save.
 */
export class ItemSyncState {
  private items = new Map<ItemId, ItemState>()
  /** The fields of each item this tab changed and hasn't saved yet */
  private readonly unsaved = new Map<ItemId, Set<ItemSyncField>>()
  /** The fields a save in flight is writing, which a load treats as unsaved until it commits */
  private saving = new Map<ItemId, Set<ItemSyncField>>()
  /** Items whose legacy unconfirmed pull was folded in, to delete from the old store once saved */
  private readonly migratingPulls = new Set<ItemId>()
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
   * Loads the stored records, at start and when this tab becomes the leader. Fields this tab hasn't
   * saved yet keep its values, and base versions keep the higher. Concurrent callers share one load.
   */
  async load(): Promise<void> {
    if (!this.isAlive()) return
    return this.loadGuard.run(() => this.executeLoad())
  }

  private async executeLoad(): Promise<void> {
    const [records, legacyPulls] = await Promise.all([
      readItemSyncRecords(this.deps.db),
      this.deps.db.getAll<LegacyUnconfirmedPull>(SYNC_LOG_STORES.unconfirmedPulls),
    ])
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

    // Migration: unconfirmed pulls had their own store, which goes once they're in the records
    const migrated: ItemId[] = []
    for (const { itemId, firstSeenAt } of legacyPulls) {
      if (this.migratingPulls.has(itemId)) continue
      const entry = entryOf(itemId)
      entry.pulledAt = Math.min(entry.pulledAt ?? firstSeenAt, firstSeenAt)
      migrated.push(itemId)
    }

    this.items = loaded
    for (const itemId of migrated) {
      this.migratingPulls.add(itemId)
      this.markUnsaved(itemId, 'pulledAt')
    }
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

  /** Records heads whose every ancestor is on the server. Only the leader records them. */
  setServerHeads(itemId: ItemId, heads: string[]): void {
    if (this.stopped) return
    const entry = this.entry(itemId)
    if (areHeadsEqual(entry.serverHeads, heads)) return
    entry.serverHeads = heads
    this.markUnsaved(itemId, 'serverHeads')
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
   * Sets or clears the item's dirty flag. Only the leader writes it: it sets the flag as it records the
   * acknowledgement of a push, in the same save as the item's server heads, and clears it once the
   * snapshot is stored. It's written every time, since this tab's copy may be stale.
   */
  setDirty(itemId: ItemId, dirty: boolean): void {
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
   * Items the startup and promotion audit should queue for a snapshot: those flagged dirty, and those
   * only a snapshot can deliver, which a dirty flag always goes with but which can't hurt to check
   */
  listFlagged(): Array<{ itemId: ItemId; dirty: boolean }> {
    return Array.from(this.items)
      .filter(([, { dirty, snapshotOnly }]) => dirty || snapshotOnly)
      .map(([itemId, { dirty }]) => ({ itemId, dirty: dirty === true }))
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

  /** Records that the log refused the item's changes or can't hold one of them */
  setSnapshotOnly(itemId: ItemId): void {
    if (this.stopped || this.isSnapshotOnly(itemId)) return
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
      await this.deleteMigratedPulls()
    })
  }

  /** Deletes legacy unconfirmed pulls whose records have been saved. A failure retries at the next save. */
  private async deleteMigratedPulls(): Promise<void> {
    const saved = Array.from(this.migratingPulls).filter(itemId => !this.isUnsaved(itemId, 'pulledAt'))
    if (saved.length === 0) return
    try {
      await this.deps.db.delete(SYNC_LOG_STORES.unconfirmedPulls, ...saved)
      for (const itemId of saved) {
        this.migratingPulls.delete(itemId)
      }
    } catch (error) {
      log.warn('Failed to delete migrated unconfirmed pulls', error)
    }
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
    this.migratingPulls.clear()
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
      // Never lowered: a tab can have loaded before the leader raised it
      const baseVersion = Math.max(stored.baseVersion ?? 0, mine.baseVersion ?? 0)
      if (baseVersion > 0) record.baseVersion = baseVersion
    } else if (field === 'pulledAt' && mine.pulledAt !== undefined && stored.pulledAt !== undefined) {
      // Keeps when the item first had them, as another tab may have recorded them first
      record.pulledAt = Math.min(stored.pulledAt, mine.pulledAt)
    } else {
      copyField(record, mine, field)
    }
  }
  return record
}
