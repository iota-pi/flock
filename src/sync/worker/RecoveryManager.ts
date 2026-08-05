import { ClientEventHub } from './SyncEventHub'
import {
  type ManualRecoveryEntry,
  readManualRecoveryEntries,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
} from '../shared/manualRecoveryStore'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { mutateDraftToMatchSnapshot } from './utils/snapshot'
import type { ItemId } from 'src/shared/schemas/items'

export class RecoveryManager {
  constructor(
    private deps: {
      accountId: string
      docStore: AutomergeDocStore
      indexManager: AutomergeIndexManager
    },
    private eventHub: ClientEventHub
  ) {}

  async pushRecoveryItems() {
    if (!this.deps.accountId) return
    try {
      const entries = await readManualRecoveryEntries(this.deps.accountId)
      this.eventHub.emit({ type: 'recoveryItemsChanged', entries })
    } catch (error) {
      console.error('[RecoveryManager] Failed to push recovery entries change', error)
    }
  }

  async retryRecoveryItem(itemId: ItemId) {
    if (!this.deps.accountId) return
    await removeManualRecoveryEntryByItemId(this.deps.accountId, itemId)
    await this.pushRecoveryItems()
  }

  async forceOverwriteRecoveryItem(itemId: ItemId) {
    if (!this.deps.accountId) return
    const localItem = await this.deps.docStore.getAutomergeItem(itemId)
    if (!localItem) {
      throw new Error(`No local item found for ${itemId}. Force delete is available instead.`)
    }

    const localSnapshot = JSON.parse(JSON.stringify(localItem)) as Record<string, unknown>
    if (Array.isArray(localItem.prayedFor)) {
      localSnapshot.prayedFor = [...localItem.prayedFor]
    }

    await this.deps.docStore.changeDocument(
      itemId,
      doc => {
        mutateDraftToMatchSnapshot(doc, localSnapshot)
        if (typeof doc.id !== 'string' || doc.id.length === 0) {
          doc.id = itemId
        }
      },
      { createIfMissing: true },
    )

    await this.deps.indexManager.addAutomergeItemIdsToIndex([itemId])

    await removeManualRecoveryEntryByItemId(this.deps.accountId, itemId)
    await this.pushRecoveryItems()
  }

  async forceDeleteRecoveryItem(itemId: ItemId) {
    if (!this.deps.accountId) return
    const existing = await this.deps.docStore.getAutomergeItem(itemId)

    await this.deps.docStore.changeDocument(
      itemId,
      doc => {
        doc.id = itemId
        doc.type = existing?.type || 'person'
        doc.deleted = true
      },
      { createIfMissing: true },
    )

    await this.deps.indexManager.addAutomergeItemIdsToIndex([itemId])

    await removeManualRecoveryEntryByItemId(this.deps.accountId, itemId)
    await this.pushRecoveryItems()
  }

  async dismissRecoveryItem(entryId: string) {
    if (!this.deps.accountId) return
    await removeManualRecoveryEntryById(this.deps.accountId, entryId)
    await this.pushRecoveryItems()
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    if (!this.deps.accountId) return []
    return await readManualRecoveryEntries(this.deps.accountId)
  }
}
