import type { ItemId } from '../../../shared/schemas/items'
import type { AccountMetadata } from '../../../state/metadata'
import type { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from './AutomergeDocStore'
import { AsyncMutex } from '../../utils/AsyncMutex'
import type { LifecycleAware } from '../ServiceLifecycleManager'

interface IndexBroadcastMessage {
  type: 'indexUpdated' | 'metadataUpdated'
  itemIds?: ItemId[]
  metadata?: AccountMetadata
}

const INDEX_LOCK_TIMEOUT_MS = 10000

export class AutomergeIndexManager implements LifecycleAware {
  readonly lifecycleName = 'IndexManager'
  private mutex = new AsyncMutex()
  private broadcastChannel: BroadcastChannel | null = null
  private lastEmittedItemIds: string[] | null = null
  private isClosed = false

  async onLifecycleStart(): Promise<void> {
    await this.ensureIndexDocument()
  }

  onLifecycleStop(): void {
    this.close()
  }

  constructor(
    private readonly accountId: string,
    public readonly indexStore: IndexStore,
    private readonly onIndexUpdated?: (itemIds: ItemId[]) => void,
    private readonly onMetadataUpdated?: (metadata: AccountMetadata) => void,
  ) {
    this.setupBroadcastChannel()
  }

  private setupBroadcastChannel(): void {
    if (typeof BroadcastChannel === 'undefined') {
      return
    }

    try {
      this.broadcastChannel = new BroadcastChannel(`flock-index-channel-${this.accountId}`)
      this.broadcastChannel.onmessage = (event: MessageEvent<IndexBroadcastMessage>) => {
        if (this.isClosed || !event.data) return

        if (event.data.type === 'indexUpdated' && Array.isArray(event.data.itemIds)) {
          this.handleRemoteIndexUpdated(event.data.itemIds)
        } else if (event.data.type === 'metadataUpdated' && event.data.metadata) {
          this.handleRemoteMetadataUpdated(event.data.metadata)
        }
      }
    } catch (err) {
      console.warn('[AutomergeIndexManager] Failed to create BroadcastChannel:', err)
      this.broadcastChannel = null
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

  private handleRemoteMetadataUpdated(metadata: AccountMetadata): void {
    this.onMetadataUpdated?.(metadata)
  }

  private emitIndexUpdated(itemIds: ItemId[]): void {
    if (this.areItemIdsEqual(this.lastEmittedItemIds, itemIds)) {
      return
    }
    this.lastEmittedItemIds = [...itemIds]
    this.onIndexUpdated?.(itemIds)

    if (!this.broadcastChannel || this.isClosed) return
    try {
      this.broadcastChannel.postMessage({
        type: 'indexUpdated',
        itemIds,
      })
    } catch (_) {
      console.warn('[AutomergeIndexManager] Failed to broadcast index update')
    }
  }

  private notifyLocalMetadataUpdated(metadata: AccountMetadata): void {
    this.onMetadataUpdated?.(metadata)
  }

  private broadcastMetadataUpdated(metadata: AccountMetadata): void {
    if (!this.broadcastChannel || this.isClosed) return
    try {
      this.broadcastChannel.postMessage({
        type: 'metadataUpdated',
        metadata,
      })
    } catch (_) {
      console.warn('[AutomergeIndexManager] Failed to broadcast metadata update')
    }
  }

  close(): void {
    this.isClosed = true
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.close()
      } catch (_) {
        console.warn('[AutomergeIndexManager] Failed to close broadcast channel')
      }
      this.broadcastChannel = null
    }
  }

  private async withLock<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      if (typeof navigator !== 'undefined' && navigator?.locks?.request) {
        const lockName = `flock-index-lock-${this.accountId}`
        const controller = new AbortController()
        const timeoutId = setTimeout(() => {
          controller.abort(new Error(`Index lock request timed out after ${INDEX_LOCK_TIMEOUT_MS}ms`))
        }, INDEX_LOCK_TIMEOUT_MS)

        try {
          return await navigator.locks.request(
            lockName,
            { mode: 'exclusive', signal: controller.signal },
            async () => {
              return await task()
            }
          )
        } finally {
          clearTimeout(timeoutId)
        }
      }

      return task()
    })
  }

  async getIndexSnapshot(): Promise<AutomergeIndexDocument> {
    const doc = await this.indexStore.getIndex()
    return {
      accountId: doc?.accountId || this.accountId,
      itemIds: doc?.itemIds ? [...doc.itemIds] : [],
      ...(doc?.tombstoneIds ? { tombstoneIds: [...doc.tombstoneIds] } : {}),
      metadata: doc?.metadata ? { ...doc.metadata } : {},
      lastSyncTime: doc?.lastSyncTime || 0,
      lastManifestSyncTime: doc?.lastManifestSyncTime || 0,
    }
  }

  async replaceIndex(indexDoc: AutomergeIndexDocument): Promise<void> {
    return this.withLock(async () => {
      await this.indexStore.saveIndex(indexDoc)
      const itemIds = indexDoc.itemIds || []
      this.emitIndexUpdated(itemIds)
      if (indexDoc.metadata) {
        this.notifyLocalMetadataUpdated(indexDoc.metadata)
        this.broadcastMetadataUpdated(indexDoc.metadata)
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
          lastSyncTime: doc?.lastSyncTime || 0,
          lastManifestSyncTime: doc?.lastManifestSyncTime || 0,
        }
        await this.indexStore.saveIndex(newDoc)
      }
    })
  }

  async addAutomergeItemIdsToIndex(itemIds: ItemId[]): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshot()
      const current = new Set(doc.itemIds || [])
      let updated = false
      for (const id of itemIds) {
        if (!current.has(id)) {
          current.add(id)
          updated = true
        }
      }
      const tombstoneSet = new Set(doc.tombstoneIds || [])
      let tombstoneUpdated = false
      for (const id of itemIds) {
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
      const doc = await this.getIndexSnapshot()
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

  async getAutomergeMetadata(): Promise<AccountMetadata> {
    const index = await this.getIndexSnapshot()
    return index.metadata || {}
  }

  async updateLocalMetadata(metadata: AccountMetadata): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshot()
      doc.metadata = metadata
      await this.indexStore.saveIndex(doc)
      this.notifyLocalMetadataUpdated(metadata)
      this.broadcastMetadataUpdated(metadata)
    })
  }

  async updateAutomergeMetadata(changes: Partial<AccountMetadata>): Promise<AccountMetadata> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshot()
      doc.metadata = { ...doc.metadata, ...changes }
      await this.indexStore.saveIndex(doc)
      this.notifyLocalMetadataUpdated(doc.metadata)
      this.broadcastMetadataUpdated(doc.metadata)
      return doc.metadata || {}
    })
  }

  async getLastSyncTime(): Promise<number> {
    const doc = await this.getIndexSnapshot()
    return doc.lastSyncTime || 0
  }

  async updateLastSyncTime(time: number): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshot()
      doc.lastSyncTime = time
      await this.indexStore.saveIndex(doc)
    })
  }

  async getLastManifestSyncTime(): Promise<number> {
    const doc = await this.getIndexSnapshot()
    return doc.lastManifestSyncTime || 0
  }

  async updateLastManifestSyncTime(time: number): Promise<void> {
    return this.withLock(async () => {
      const doc = await this.getIndexSnapshot()
      doc.lastManifestSyncTime = time
      await this.indexStore.saveIndex(doc)
    })
  }
}
