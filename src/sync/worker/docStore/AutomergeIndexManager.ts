import type { ItemId } from '../../../shared/schemas/items'
import type { AccountMetadata } from '../../../state/metadata'
import type { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from './AutomergeDocStore'

export class AutomergeIndexManager {
  private queueTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly accountId: string,
    public readonly indexStore: IndexStore,
    private readonly onIndexUpdated?: (itemIds: ItemId[]) => void,
    private readonly onMetadataUpdated?: (metadata: AccountMetadata) => void,
  ) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const previousTail = this.queueTail

    const taskPromise = (async () => {
      await previousTail.catch(() => {})
      return task()
    })()

    this.queueTail = taskPromise.then(() => {}).catch(() => {})

    return taskPromise
  }

  async getIndexSnapshot(): Promise<AutomergeIndexDocument> {
    const doc = await this.indexStore.getIndex()
    return {
      accountId: doc?.accountId || this.accountId,
      itemIds: doc?.itemIds || [],
      metadata: doc?.metadata || {},
      lastModified: doc?.lastModified || {},
      lastSyncTime: doc?.lastSyncTime || 0,
    }
  }

  async ensureIndexDocument(): Promise<void> {
    return this.enqueue(async () => {
      const doc = await this.indexStore.getIndex()
      if (!doc || !doc.accountId) {
        const newDoc: AutomergeIndexDocument = {
          accountId: this.accountId,
          itemIds: doc?.itemIds || [],
          metadata: doc?.metadata || {},
          lastModified: doc?.lastModified || {},
          lastSyncTime: doc?.lastSyncTime || 0,
        }
        await this.indexStore.saveIndex(newDoc)
      }
    })
  }

  async addAutomergeItemIdsToIndex(itemIds: ItemId[]): Promise<void> {
    return this.enqueue(async () => {
      const doc = await this.getIndexSnapshot()
      const current = new Set(doc.itemIds || [])
      let updated = false
      for (const id of itemIds) {
        if (!current.has(id)) {
          current.add(id)
          updated = true
        }
      }
      if (updated) {
        doc.itemIds = Array.from(current)
        await this.indexStore.saveIndex(doc)
        this.onIndexUpdated?.(doc.itemIds)
      }
    })
  }

  async removeAutomergeItemIdsFromIndex(itemIds: ItemId[]): Promise<void> {
    return this.enqueue(async () => {
      const doc = await this.getIndexSnapshot()
      const removeSet = new Set(itemIds)
      const newItemIds = doc.itemIds?.filter(id => !removeSet.has(id)) || []
      const lastModified = doc.lastModified || {}

      for (const id of removeSet) {
        delete lastModified[id]
      }

      doc.itemIds = newItemIds
      doc.lastModified = lastModified
      await this.indexStore.saveIndex(doc)
      this.onIndexUpdated?.(newItemIds)
    })
  }

  async listAutomergeItemIds(): Promise<ItemId[]> {
    const index = await this.getIndexSnapshot()
    return index.itemIds || []
  }

  async getAutomergeMetadata(): Promise<AccountMetadata> {
    const index = await this.getIndexSnapshot()
    return index.metadata || {}
  }

  async updateLocalMetadata(metadata: AccountMetadata): Promise<void> {
    return this.enqueue(async () => {
      const doc = await this.getIndexSnapshot()
      doc.metadata = metadata
      await this.indexStore.saveIndex(doc)
      this.onMetadataUpdated?.(metadata)
    })
  }

  async updateAutomergeMetadata(changes: Partial<AccountMetadata>): Promise<AccountMetadata> {
    return this.enqueue(async () => {
      const doc = await this.getIndexSnapshot()
      doc.metadata = { ...doc.metadata, ...changes }
      await this.indexStore.saveIndex(doc)
      this.onMetadataUpdated?.(doc.metadata)
      return doc.metadata || {}
    })
  }

  async updateLocalLastModified(lastModified: Record<ItemId, number>): Promise<void> {
    return this.enqueue(async () => {
      const doc = await this.getIndexSnapshot()
      doc.lastModified = { ...doc.lastModified, ...lastModified }
      await this.indexStore.saveIndex(doc)
    })
  }

  async getLastSyncTime(): Promise<number> {
    const doc = await this.getIndexSnapshot()
    return doc.lastSyncTime || 0
  }

  async updateLastSyncTime(time: number): Promise<void> {
    return this.enqueue(async () => {
      const doc = await this.getIndexSnapshot()
      doc.lastSyncTime = time
      await this.indexStore.saveIndex(doc)
    })
  }
}
