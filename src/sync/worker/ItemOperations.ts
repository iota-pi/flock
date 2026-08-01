import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { ClientEventHub } from './SyncEventHub'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { DeletionQueueManager } from './deletionQueueManager'
import type { ItemId } from 'src/shared/schemas/items'

export interface ItemOperationsDeps {
  accountId: string
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  eventHub: ClientEventHub
  markDocumentDirty: (itemId: ItemId) => void
  deletionQueueManager: DeletionQueueManager
}

export class ItemOperations {
  constructor(private deps: ItemOperationsDeps) {}

  async mutateItem(mutationId: string, id: ItemId, changes: Partial<Item>): Promise<void> {
    try {
      const updated = await this.deps.docStore.changeDocument(
        id,
        doc => {
          for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) delete doc[key]
            else doc[key] = value
          }
        },
        { knownToExist: true },
      )
      if (updated) {
        this.deps.markDocumentDirty(id)
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId, error: (err as Error).message })
      const trueState = await this.deps.docStore.getAutomergeItem(id)
      this.deps.eventHub.emit({ type: 'itemUpdated', id, item: trueState })
    }
  }

  async createItem(item: Item): Promise<void> {
    try {
      const updated = await this.deps.docStore.changeDocument(
        item.id,
        doc => {
          for (const [key, value] of Object.entries(item)) {
            doc[key] = value
          }
        },
        { createIfMissing: true, knownToExist: false },
      )
      if (updated) {
        await this.deps.indexManager.addAutomergeItemIdsToIndex([item.id])
        this.deps.markDocumentDirty(item.id)
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'create', error: (err as Error).message })
    }
  }

  async hardDeleteItems(itemIds: ItemId[]): Promise<void> {
    try {
      for (const id of itemIds) {
        await this.deps.deletionQueueManager.cancelDeletion(id).catch(console.error)
        await this.deps.docStore.removeAutomergeItem(id)
        await this.deps.indexManager.removeAutomergeItemIdsFromIndex([id])
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'hardDelete', error: (err as Error).message })
    }
  }

  async storeItems(items: Item[]): Promise<void> {
    const failedItems: { item: Item; error: Error }[] = []
    const succeededIds: ItemId[] = []
    const existingIds = new Set(await this.deps.indexManager.listAutomergeItemIds())

    for (const item of items) {
      try {
        const updated = await this.deps.docStore.changeDocument(
          item.id,
          doc => {
            for (const [key, value] of Object.entries(item)) {
              if (value === undefined) delete doc[key]
              else doc[key] = value
            }
          },
          { createIfMissing: true, knownToExist: existingIds.has(item.id) }
        )
        if (updated) {
          succeededIds.push(item.id)
          this.deps.markDocumentDirty(item.id)
        }
      } catch (err) {
        failedItems.push({ item, error: err as Error })
      }
    }

    if (succeededIds.length > 0) {
      await this.deps.indexManager.addAutomergeItemIdsToIndex(succeededIds)
    }

    if (failedItems.length > 0) {
      const combinedMessage = failedItems.map(f => `${f.item.id}: ${(f.error as Error).message}`).join(', ')
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'store', error: combinedMessage })
      for (const { item } of failedItems) {
        const trueState = await this.deps.docStore.getAutomergeItem(item.id)
        this.deps.eventHub.emit({ type: 'itemUpdated', id: item.id, item: trueState })
      }
    }
  }

  async mutateMetadata(changes: Partial<AccountMetadata>): Promise<void> {
    try {
      await this.deps.indexManager.updateAutomergeMetadata(changes)
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'metadata', error: (err as Error).message })
      const metadata = await this.deps.indexManager.getAutomergeMetadata()
      this.deps.eventHub.emit({ type: 'metadataUpdated', metadata })
    }
  }
}
