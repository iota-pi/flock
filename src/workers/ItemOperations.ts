import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { SyncEventHub } from '../sync/SyncEventHub'
import {
  withAutomergeDocumentChange,
  withAutomergeMetadataChange,
  addAutomergeItemIdsToIndex,
  removeAutomergeItemIdsFromIndex,
  removeAutomergeItem,
  getAutomergeItem,
  getAutomergeMetadata,
  ACCOUNT_INDEX_DOCUMENT_ID,
} from '../sync/docStore'
import type { DeletionQueueManager } from './deletionQueueManager'
import type { ItemId } from 'src/shared/schemas/items'

export interface ItemOperationsDeps {
  getAccountId: () => string | null
  eventHub: SyncEventHub
  markDocumentDirty: (itemId: ItemId) => void
  getDeletionQueueManager: () => DeletionQueueManager
}

export class ItemOperations {
  constructor(private deps: ItemOperationsDeps) {}

  private get accountId(): string {
    const id = this.deps.getAccountId()
    if (!id) throw new Error('Account ID not set')
    return id
  }

  async mutateItem(mutationId: string, id: ItemId, changes: Partial<Item>): Promise<void> {
    try {
      const updated = await withAutomergeDocumentChange(this.accountId, id, doc => {
        for (const [key, value] of Object.entries(changes)) {
          if (value === undefined) delete doc[key]
          else doc[key] = value
        }
      })
      if (updated) {
        this.deps.markDocumentDirty(id)
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId, error: (err as Error).message })
      const trueState = await getAutomergeItem(this.accountId, id)
      this.deps.eventHub.emit({ type: 'itemUpdated', id, item: trueState })
    }
  }

  async createItem(item: Item): Promise<void> {
    try {
      const updated = await withAutomergeDocumentChange(this.accountId, item.id, doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      }, { createIfMissing: true, initialValue: item })
      await addAutomergeItemIdsToIndex(this.accountId, [item.id])
      if (updated) {
        this.deps.markDocumentDirty(item.id)
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'create', error: (err as Error).message })
    }
  }

  async hardDeleteItems(itemIds: ItemId[]): Promise<void> {
    try {
      await removeAutomergeItemIdsFromIndex(this.accountId, itemIds)
      for (const id of itemIds) {
        await this.deps.getDeletionQueueManager().cancelDeletion(id).catch(console.error)
        await removeAutomergeItem(this.accountId, id)
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'hardDelete', error: (err as Error).message })
    }
  }

  async storeItems(items: Item[]): Promise<void> {
    const succeededIds = new Set<string>()
    const failedItems: { item: Item; error: Error }[] = []

    for (const item of items) {
      try {
        const updated = await withAutomergeDocumentChange(this.accountId, item.id, doc => {
          for (const [key, value] of Object.entries(item)) {
            if (value === undefined) delete doc[key]
            else doc[key] = value
          }
        }, { createIfMissing: true, initialValue: item })
        if (updated) {
          this.deps.markDocumentDirty(item.id)
        }
        succeededIds.add(item.id)
      } catch (err) {
        failedItems.push({ item, error: err as Error })
      }
    }

    if (failedItems.length > 0) {
      const combinedMessage = failedItems.map(f => `${f.item.id}: ${ (f.error as Error).message }`).join(', ')
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'store', error: combinedMessage })
      for (const { item } of failedItems) {
        const trueState = await getAutomergeItem(this.accountId, item.id)
        this.deps.eventHub.emit({ type: 'itemUpdated', id: item.id, item: trueState })
      }
    }
  }

  async mutateMetadata(changes: Partial<AccountMetadata>): Promise<void> {
    try {
      const updated = await withAutomergeMetadataChange(this.accountId, metadataDraft => {
        for (const [key, value] of Object.entries(changes)) {
          metadataDraft[key] = value
        }
      })
      if (updated) {
        this.deps.markDocumentDirty(ACCOUNT_INDEX_DOCUMENT_ID)
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationId: 'metadata', error: (err as Error).message })
      const metadata = await getAutomergeMetadata(this.accountId)
      this.deps.eventHub.emit({ type: 'metadataUpdated', metadata })
    }
  }
}
