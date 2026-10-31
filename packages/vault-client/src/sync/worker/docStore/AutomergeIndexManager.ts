import type { ItemId } from '@vault/shared'
import type { VaultMetadata } from '../../shared/types'
import type { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from './AutomergeDocStore'
import { AsyncMutex } from '../../utils/AsyncMutex'
import { getVaultStorageNames } from '../../shared/storageNames'
import { withTimeout } from '../../utils/abort'
import { SYNC_TIMEOUTS } from '../../shared/syncConfig'
import type { RealtimeBus } from '../realtimeBus'

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
  /** Tells the account's other tabs about index and metadata changes, and hears theirs */
  bus?: RealtimeBus
  onIndexUpdated?: (itemIds: ItemId[]) => void
  onMetadataUpdated?: (metadata: VaultMetadata) => void
}

export class AutomergeIndexManager {
  private mutex = new AsyncMutex()
  private lastEmittedItemIds: string[] | null = null
  private isClosed = false
  private readonly accountId: string
  public readonly indexStore: IndexStore
  private readonly bus: RealtimeBus | null
  private readonly onIndexUpdated?: (itemIds: ItemId[]) => void
  private readonly onMetadataUpdated?: (metadata: VaultMetadata) => void
  private readonly unsubscribers: Array<() => void> = []

  constructor(options: AutomergeIndexManagerOptions) {
    this.accountId = options.accountId
    this.indexStore = options.indexStore
    this.bus = options.bus ?? null
    this.onIndexUpdated = options.onIndexUpdated
    this.onMetadataUpdated = options.onMetadataUpdated
    if (this.bus) {
      this.unsubscribers.push(
        this.bus.subscribeIndexUpdated(itemIds => {
          if (!this.isClosed) this.handleRemoteIndexUpdated(itemIds)
        }),
        this.bus.subscribeMetadataUpdated(metadata => {
          if (!this.isClosed) this.handleRemoteMetadataUpdated(metadata)
        }),
      )
    }
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

  private handleRemoteIndexUpdated(itemIds: ItemId[]): void {
    if (this.areItemIdsEqual(this.lastEmittedItemIds, itemIds)) {
      return
    }
    this.lastEmittedItemIds = [...itemIds]
    this.onIndexUpdated?.(itemIds)
  }

  private handleRemoteMetadataUpdated(metadata: VaultMetadata): void {
    this.onMetadataUpdated?.(metadata)
  }

  private emitIndexUpdated(itemIds: ItemId[]): void {
    if (this.areItemIdsEqual(this.lastEmittedItemIds, itemIds)) {
      return
    }
    this.lastEmittedItemIds = [...itemIds]
    this.onIndexUpdated?.(itemIds)
    if (!this.isClosed) {
      this.bus?.publishIndexUpdated(itemIds)
    }
  }

  private notifyLocalMetadataUpdated(metadata: VaultMetadata): void {
    this.onMetadataUpdated?.(metadata)
  }

  private broadcastMetadataUpdated(metadata: VaultMetadata): void {
    if (!this.isClosed) {
      this.bus?.publishMetadataUpdated(metadata)
    }
  }

  close(): void {
    this.isClosed = true
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      if (typeof navigator !== 'undefined' && navigator?.locks?.request) {
        const lockName = `${getVaultStorageNames().accountPrefixes.indexLock}${this.accountId}`
        return withTimeout(
          SYNC_TIMEOUTS.indexLock,
          signal => navigator.locks.request(lockName, { mode: 'exclusive', signal }, task),
          { reason: new Error(`Index lock request timed out after ${SYNC_TIMEOUTS.indexLock}ms`) },
        )
      }

      return task()
    })
  }

  private async getIndexSnapshotInternal(): Promise<AutomergeIndexDocument> {
    const doc = await this.indexStore.getIndex()
    return {
      accountId: doc?.accountId || this.accountId,
      itemIds: doc?.itemIds ? [...doc.itemIds] : [],
      ...(doc?.tombstoneIds ? { tombstoneIds: [...doc.tombstoneIds] } : {}),
      metadata: doc?.metadata ? { ...doc.metadata } : {},
      lastManifestSyncTime: doc?.lastManifestSyncTime || 0,
    }
  }

  async getIndexSnapshot(): Promise<AutomergeIndexDocument> {
    return this.withLock(async () => this.getIndexSnapshotInternal())
  }

  /**
   * Merges an index from a backup into this one. Items this device knows about stay as they are, so a
   * restore can't hide items created since the backup or bring deleted ones back. The backup's
   * metadata wins, and the manifest sync time stays this device's own.
   */
  async mergeIndex(backup: AutomergeIndexDocument): Promise<void> {
    return this.withLock(async () => {
      const doc = mergeIndexDocuments(await this.getIndexSnapshotInternal(), backup)
      await this.indexStore.saveIndex(doc)
      this.emitIndexUpdated(doc.itemIds)
      if (backup.metadata) {
        this.notifyLocalMetadataUpdated(doc.metadata || {})
        this.broadcastMetadataUpdated(doc.metadata || {})
      }
    })
  }

  async ensureIndexDocument(): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.indexStore.getIndex()
      if (!doc || !doc.accountId) {
        const newDoc: AutomergeIndexDocument = {
          accountId: this.accountId,
          itemIds: doc?.itemIds || [],
          ...(doc?.tombstoneIds ? { tombstoneIds: [...doc.tombstoneIds] } : {}),
          metadata: doc?.metadata || {},
          lastManifestSyncTime: doc?.lastManifestSyncTime || 0,
        }
        await this.indexStore.saveIndex(newDoc)
      }
    })
  }

  /**
   * Adds items to the index, taking them out of the tombstones unless `skipTombstoned` is set. Set it
   * when the IDs don't come from a live local doc (such as another tab's sync ping, which can name
   * deleted items); a tombstoned ID is then left as it is.
   */
  async addAutomergeItemIdsToIndex(itemIds: ItemId[], options?: { skipTombstoned?: boolean }): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshotInternal()
      const current = new Set(doc.itemIds || [])
      const tombstoneSet = new Set(doc.tombstoneIds || [])
      const idsToAdd = options?.skipTombstoned ? itemIds.filter(id => !tombstoneSet.has(id)) : itemIds
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
        await this.indexStore.saveIndex(doc)
        if (updated) {
          this.emitIndexUpdated(doc.itemIds)
        }
      }
    })
  }

  async removeAutomergeItemIdsFromIndex(itemIds: ItemId[]): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshotInternal()
      const removeSet = new Set(itemIds)
      const current = doc.itemIds || []
      const newItemIds = current.filter(id => !removeSet.has(id))
      const tombstoneSet = new Set(doc.tombstoneIds || [])
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
        await this.indexStore.saveIndex(doc)
        if (newItemIds.length !== current.length) {
          this.emitIndexUpdated(newItemIds)
        }
      }
    })
  }

  async listAutomergeItemIds(): Promise<ItemId[]> {
    const index = await this.getIndexSnapshot()
    return index.itemIds || []
  }

  async listAutomergeTombstoneIds(): Promise<ItemId[]> {
    const index = await this.getIndexSnapshot()
    return index.tombstoneIds || []
  }

  async getAutomergeMetadata(): Promise<VaultMetadata> {
    const index = await this.getIndexSnapshot()
    return index.metadata || {}
  }

  async updateAutomergeMetadata(changes: Partial<VaultMetadata>): Promise<VaultMetadata> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshotInternal()
      doc.metadata = { ...doc.metadata, ...changes }
      await this.indexStore.saveIndex(doc)
      this.notifyLocalMetadataUpdated(doc.metadata)
      this.broadcastMetadataUpdated(doc.metadata)
      return doc.metadata || {}
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
      await this.indexStore.saveIndex(doc)
      this.notifyLocalMetadataUpdated(metadata)
      this.broadcastMetadataUpdated(metadata)
    })
  }

  async getLastManifestSyncTime(): Promise<number> {
    const doc = await this.getIndexSnapshot()
    return doc.lastManifestSyncTime || 0
  }

  async updateLastManifestSyncTime(time: number): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshotInternal()
      doc.lastManifestSyncTime = time
      await this.indexStore.saveIndex(doc)
    })
  }
}
