import type { SyncCallbacks } from './syncProtocol'
import {
  type ManualRecoveryEntry,
  readManualRecoveryEntries,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
} from '../sync/manualRecoveryStore'
import {
  getAutomergeItem,
  withAutomergeDocumentChange,
} from '../sync/docStore'
import { mutateDraftToMatchSnapshot } from './utils'
import { ItemId } from 'src/shared/schemas/items'

export class RecoveryManager {
  constructor(
    private getContext: () => {
      accountId: string | null
      callbacks: SyncCallbacks | null
    }
  ) {}

  async pushRecoveryItems() {
    const { callbacks, accountId } = this.getContext()
    if (callbacks && accountId) {
      try {
        const entries = await readManualRecoveryEntries(accountId)
        await callbacks.onRecoveryItemsChanged(entries)
      } catch (error) {
        console.error('[RecoveryManager] Failed to push recovery entries change', error)
      }
    }
  }

  async retryRecoveryItem(itemId: ItemId) {
    const { accountId } = this.getContext()
    if (!accountId) return
    await removeManualRecoveryEntryByItemId(accountId, itemId)
    await this.pushRecoveryItems()
  }

  async forceOverwriteRecoveryItem(itemId: ItemId) {
    const { accountId } = this.getContext()
    if (!accountId) return

    const localItem = await getAutomergeItem(accountId, itemId)
    if (!localItem) {
      throw new Error(`No local item found for ${itemId}. Force delete is available instead.`)
    }

    const localSnapshot = JSON.parse(JSON.stringify(localItem)) as Record<string, unknown>
    if (Array.isArray(localItem.prayedFor)) {
      localSnapshot.prayedFor = [...localItem.prayedFor]
    }

    await withAutomergeDocumentChange(
      accountId,
      itemId,
      doc => {
        mutateDraftToMatchSnapshot(doc, localSnapshot)
        if (typeof doc.id !== 'string' || doc.id.length === 0) {
          doc.id = itemId
        }
      },
      {
        createIfMissing: true,
        initialValue: { id: itemId },
      },
    )

    await removeManualRecoveryEntryByItemId(accountId, itemId)
    await this.pushRecoveryItems()
  }

  async forceDeleteRecoveryItem(itemId: ItemId) {
    const { accountId } = this.getContext()
    if (!accountId) return

    const existing = await getAutomergeItem(accountId, itemId)

    await withAutomergeDocumentChange(
      accountId,
      itemId,
      doc => {
        doc.id = itemId
        doc.type = existing?.type || 'person'
        doc.deleted = true
      },
      {
        createIfMissing: true,
        initialValue: {
          id: itemId,
        },
      },
    )

    await removeManualRecoveryEntryByItemId(accountId, itemId)
    await this.pushRecoveryItems()
  }

  async dismissRecoveryItem(entryId: string) {
    const { accountId } = this.getContext()
    if (!accountId) return
    await removeManualRecoveryEntryById(accountId, entryId)
    await this.pushRecoveryItems()
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    const { accountId } = this.getContext()
    if (!accountId) return []
    return await readManualRecoveryEntries(accountId)
  }
}
