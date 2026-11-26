import type { ItemId } from '@vault/shared'
import type { VaultMetadata } from '../../shared/types'
import type { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from './AutomergeDocStore'
import { AsyncMutex } from '../../utils/AsyncMutex'
import { getVaultStorageNames } from '../../shared/storageNames'
import { withTimeout } from '../../utils/abort'
import { SYNC_TIMEOUTS } from '../../shared/syncConfig'

/** An index document with every field filled in */
export type NormalizedIndexDocument = Required<AutomergeIndexDocument>

/** Fills in an index document's missing fields, copying its arrays and metadata */
function normalizeIndexDocument(doc: AutomergeIndexDocument | null | undefined, accountId: string): NormalizedIndexDocument {
  return {
    accountId: doc?.accountId || accountId,
    itemIds: doc?.itemIds ? [...doc.itemIds] : [],
    tombstoneIds: doc?.tombstoneIds ? [...doc.tombstoneIds] : [],
    metadata: doc?.metadata ? { ...doc.metadata } : {},
    lastManifestSyncTime: doc?.lastManifestSyncTime || 0,
  }
}

export interface MergeIndexOptions {
  /** Tombstones from either side win, rather than only the incoming ones for items not live locally */
  tombstonesWin?: boolean
  /** Which side's metadata wins for keys both have (default: incoming) */
  metadata?: 'incoming' | 'local'
}

/**
 * Merges another copy of an index into this device's. By default, items this device knows about stay
 * as they are, so a backup can't hide items created since or bring deleted ones back. With
 * `tombstonesWin`, a deletion on either side holds, since deletes are terminal. The manifest sync time stays
 * this device's own.
 */
export function mergeIndexDocuments(
  local: AutomergeIndexDocument,
  incoming: AutomergeIndexDocument,
  options: MergeIndexOptions = {},
): AutomergeIndexDocument & Required<Pick<AutomergeIndexDocument, 'itemIds' | 'tombstoneIds' | 'metadata'>> {
  const itemIds = new Set(local.itemIds || [])
  const tombstoneIds = new Set(local.tombstoneIds || [])
  for (const id of incoming.tombstoneIds || []) {
    if (options.tombstonesWin) {
      itemIds.delete(id)
      tombstoneIds.add(id)
    } else if (!itemIds.has(id)) {
      tombstoneIds.add(id)
    }
  }
  for (const id of incoming.itemIds || []) {
    if (!tombstoneIds.has(id)) itemIds.add(id)
  }
  const metadata = options.metadata === 'local'
    ? { ...incoming.metadata, ...local.metadata }
    : { ...local.metadata, ...incoming.metadata }
  return {
    ...local,
    itemIds: Array.from(itemIds),
    tombstoneIds: Array.from(tombstoneIds),
    metadata,
  }
}

export interface AutomergeIndexManagerOptions {
  accountId: string
  indexStore: IndexStore
  onIndexUpdated?: (itemIds: ItemId[]) => void
  onMetadataUpdated?: (metadata: VaultMetadata) => void
}

/**
 * The account's item index: live item IDs, tombstones and local metadata.
 *
 * Only the account's active tab runs an engine (see "One active tab" in docs/sync-design.md), so
 * nothing else writes the index while this session runs and reads come from a copy kept in memory.
 * Writes still read the stored index under the cross-tab index lock and change that, so a write from
 * a frozen tab that thawed after a takeover, or an older build's tab, is never overwritten with this
 * session's copy and a tombstone is never undone by it (rule 2). Every operation, read or write, runs
 * in the order it was called.
 */
export class AutomergeIndexManager {
  private mutex = new AsyncMutex()
  private lastEmittedItemIds: string[] | null = null
  /** The index as this session last read or wrote it. Only touched while holding the mutex. */
  private cached: NormalizedIndexDocument | null = null
  public readonly indexStore: IndexStore

  constructor(private readonly deps: AutomergeIndexManagerOptions) {
    this.indexStore = deps.indexStore
  }

  private areItemIdsEqual(a: string[] | null, b: string[]): boolean {
    if (!a) return false
    if (a.length !== b.length) return false
    const setA = new Set(a)
    for (const id of b) {
      if (!setA.has(id)) return false
    }
    return true
  }

  /** Tells `onIndexUpdated` about the item IDs unless they're the ones it last heard. Returns whether it did. */
  private notifyIndexUpdated(itemIds: ItemId[]): boolean {
    if (this.areItemIdsEqual(this.lastEmittedItemIds, itemIds)) {
      return false
    }
    this.lastEmittedItemIds = [...itemIds]
    this.deps.onIndexUpdated?.(itemIds)
    return true
  }

  private emitIndexUpdated(itemIds: ItemId[]): void {
    this.notifyIndexUpdated(itemIds)
  }

  private emitMetadataUpdated(metadata: VaultMetadata): void {
    this.deps.onMetadataUpdated?.(metadata)
  }

  /** Runs `task` with the stored index under the cross-tab index lock. Call it holding the mutex. */
  private async withIndexLock<T>(task: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator?.locks?.request) {
      const lockName = `${getVaultStorageNames().accountPrefixes.indexLock}${this.deps.accountId}`
      return withTimeout(
        SYNC_TIMEOUTS.indexLock,
        signal => navigator.locks.request(lockName, { mode: 'exclusive', signal }, task),
        { reason: new Error(`Index lock request timed out after ${SYNC_TIMEOUTS.indexLock}ms`) },
      )
    }
    return task()
  }

  /** Runs a write: in order with every other operation, and under the cross-tab index lock */
  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(() => this.withIndexLock(task))
  }

  /**
   * Runs a write unless this session's copy of the index says it would change nothing. Most calls
   * change nothing (every item is re-added when it's bound at startup), and skipping one never
   * undoes a tombstone, so a stale copy can only cause a write that finds nothing to change.
   */
  private async withLockUnlessUnchanged(
    isUnchanged: (doc: NormalizedIndexDocument) => boolean,
    task: () => Promise<void>,
  ): Promise<void> {
    return this.mutex.runExclusive(async () => {
      if (isUnchanged(await this.getCached())) return
      await this.withIndexLock(task)
    })
  }

  /** Runs a read of this session's copy of the index, loading it on first use, in order with every other operation */
  private async read<T>(select: (doc: NormalizedIndexDocument) => T): Promise<T> {
    return this.mutex.runExclusive(async () => select(await this.getCached()))
  }

  /** This session's copy of the index. Call it holding the mutex. A failed load isn't kept, so it throws again. */
  private async getCached(): Promise<NormalizedIndexDocument> {
    this.cached ??= normalizeIndexDocument(await this.indexStore.getIndex(), this.deps.accountId)
    return this.cached
  }

  /** Reads the stored index, which becomes this session's copy. Call it under the index lock. */
  private async getIndexSnapshotInternal(): Promise<NormalizedIndexDocument> {
    const doc = normalizeIndexDocument(await this.indexStore.getIndex(), this.deps.accountId)
    this.cached = normalizeIndexDocument(doc, this.deps.accountId)
    return doc
  }

  /** Stores the index, which becomes this session's copy. Call it under the index lock. */
  private async saveIndex(doc: AutomergeIndexDocument): Promise<void> {
    // A failed save leaves the stored index unknown, so the next read loads it again
    this.cached = null
    await this.indexStore.saveIndex(doc)
    this.cached = normalizeIndexDocument(doc, this.deps.accountId)
  }

  async getIndexSnapshot(): Promise<NormalizedIndexDocument> {
    return this.read(doc => normalizeIndexDocument(doc, this.deps.accountId))
  }

  /**
   * Merges an index from a backup into this one. Items this device knows about stay as they are, so a
   * restore can't hide items created since the backup or bring deleted ones back. The backup's
   * metadata wins, and the manifest sync time stays this device's own.
   */
  async mergeIndex(backup: AutomergeIndexDocument): Promise<void> {
    return this.withLock(async () => {
      const doc = mergeIndexDocuments(await this.getIndexSnapshotInternal(), backup)
      await this.saveIndex(doc)
      this.emitIndexUpdated(doc.itemIds)
      if (backup.metadata) {
        this.emitMetadataUpdated(doc.metadata)
      }
    })
  }

  async ensureIndexDocument(): Promise<void> {
    return this.withLock(async () => {
      const stored = await this.indexStore.getIndex()
      const doc = normalizeIndexDocument(stored, this.deps.accountId)
      if (stored?.accountId) {
        this.cached = doc
      } else {
        await this.saveIndex(doc)
      }
    })
  }

  /** Adds items to the index, taking them out of the tombstones */
  async addItemIds(itemIds: ItemId[]): Promise<void> {
    const isUnchanged = (doc: NormalizedIndexDocument) => {
      const live = new Set(doc.itemIds)
      const tombstones = new Set(doc.tombstoneIds)
      return itemIds.every(id => live.has(id) && !tombstones.has(id))
    }
    return this.withLockUnlessUnchanged(isUnchanged, async () => {
      const doc = await this.getIndexSnapshotInternal()
      const current = new Set(doc.itemIds)
      const tombstoneSet = new Set(doc.tombstoneIds)
      const idsToAdd = itemIds
      let updated = false
      for (const id of idsToAdd) {
        if (!current.has(id)) {
          current.add(id)
          updated = true
        }
      }
      let tombstoneUpdated = false
      for (const id of idsToAdd) {
        if (tombstoneSet.has(id)) {
          tombstoneSet.delete(id)
          tombstoneUpdated = true
        }
      }
      if (updated || tombstoneUpdated) {
        doc.itemIds = Array.from(current)
        doc.tombstoneIds = Array.from(tombstoneSet)
        await this.saveIndex(doc)
        if (updated) {
          this.emitIndexUpdated(doc.itemIds)
        }
      }
    })
  }

  async removeItemIds(itemIds: ItemId[]): Promise<void> {
    const isUnchanged = (doc: NormalizedIndexDocument) => {
      const live = new Set(doc.itemIds)
      const tombstones = new Set(doc.tombstoneIds)
      return itemIds.every(id => !live.has(id) && tombstones.has(id))
    }
    return this.withLockUnlessUnchanged(isUnchanged, async () => {
      const doc = await this.getIndexSnapshotInternal()
      const removeSet = new Set(itemIds)
      const current = doc.itemIds
      const newItemIds = current.filter(id => !removeSet.has(id))
      const tombstoneSet = new Set(doc.tombstoneIds)
      let tombstoneUpdated = false
      for (const id of itemIds) {
        if (!tombstoneSet.has(id)) {
          tombstoneSet.add(id)
          tombstoneUpdated = true
        }
      }

      if (newItemIds.length !== current.length || tombstoneUpdated) {
        doc.itemIds = newItemIds
        doc.tombstoneIds = Array.from(tombstoneSet)
        await this.saveIndex(doc)
        if (newItemIds.length !== current.length) {
          this.emitIndexUpdated(newItemIds)
        }
      }
    })
  }

  async listItemIds(): Promise<ItemId[]> {
    return this.read(doc => [...doc.itemIds])
  }

  async listTombstoneIds(): Promise<ItemId[]> {
    return this.read(doc => [...doc.tombstoneIds])
  }

  async getMetadata(): Promise<VaultMetadata> {
    return this.read(doc => ({ ...doc.metadata }))
  }

  async updateMetadata(changes: Partial<VaultMetadata>): Promise<VaultMetadata> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshotInternal()
      doc.metadata = { ...doc.metadata, ...changes }
      await this.saveIndex(doc)
      this.emitMetadataUpdated(doc.metadata)
      return doc.metadata
    })
  }

  async removeMetadataKeys(keys: readonly string[]): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshotInternal()
      const metadata = { ...doc.metadata }
      const present = keys.filter(key => key in metadata)
      if (present.length === 0) return
      for (const key of present) {
        delete metadata[key]
      }
      doc.metadata = metadata
      await this.saveIndex(doc)
      this.emitMetadataUpdated(metadata)
    })
  }

  async getLastManifestSyncTime(): Promise<number> {
    return this.read(doc => doc.lastManifestSyncTime)
  }

  async updateLastManifestSyncTime(time: number): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshotInternal()
      doc.lastManifestSyncTime = time
      await this.saveIndex(doc)
    })
  }
}
