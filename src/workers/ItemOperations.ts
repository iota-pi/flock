import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import type { SyncCallbacks } from './syncProtocol'
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

export interface ItemOperationsDeps {
  getAccountId: () => string | null
  getCallbacks: () => SyncCallbacks | null
  markDocumentDirty: (documentId: string) => void
  getDeletionQueueManager: () => DeletionQueueManager
}

export class ItemOperations {
  constructor(private deps: ItemOperationsDeps) {}

  private get accountId(): string {
    const id = this.deps.getAccountId()
    if (!id) throw new Error('Account ID not set')
    return id
  }

  private get callbacks(): SyncCallbacks | null {
    return this.deps.getCallbacks()
  }

  async mutateItem(mutationId: string, id: string, changes: Partial<Item>): Promise<void> {
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
    } catch (err: any) {
      if (this.callbacks) {
        this.callbacks.onMutationFailed(mutationId, err.message).catch(console.error)
        const trueState = await getAutomergeItem(this.accountId, id)
        this.callbacks.onItemUpdated(id, trueState).catch(console.error)
      }
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
    } catch (err: any) {
      this.callbacks?.onMutationFailed('create', err.message).catch(console.error)
    }
  }

  async hardDeleteItems(itemIds: string[]): Promise<void> {
    try {
      await removeAutomergeItemIdsFromIndex(this.accountId, itemIds)
      for (const id of itemIds) {
        await this.deps.getDeletionQueueManager().cancelDeletion(id).catch(console.error)
        await removeAutomergeItem(this.accountId, id)
      }
    } catch (err: any) {
      this.callbacks?.onMutationFailed('hardDelete', err.message).catch(console.error)
    }
  }

  async storeItems(items: Item[]): Promise<void> {
    const succeededIds = new Set<string>()
    const failedItems: { item: Item; error: any }[] = []

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
      } catch (err: any) {
        failedItems.push({ item, error: err })
      }
    }

    if (failedItems.length > 0) {
      const combinedMessage = failedItems.map(f => `${f.item.id}: ${f.error.message}`).join(', ')
      this.callbacks?.onMutationFailed('store', combinedMessage).catch(console.error)
      for (const { item } of failedItems) {
        const trueState = await getAutomergeItem(this.accountId, item.id)
        this.callbacks?.onItemUpdated(item.id, trueState).catch(console.error)
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
    } catch (err: any) {
      this.callbacks?.onMutationFailed('metadata', err.message).catch(console.error)
      this.callbacks?.onMetadataUpdated(await getAutomergeMetadata(this.accountId)).catch(console.error)
    }
  }
}
