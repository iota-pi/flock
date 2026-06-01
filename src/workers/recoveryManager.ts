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
} from '../sync/automergeDocStore'
import { mutateDraftToMatchSnapshot } from './utils'

export class RecoveryManager {
  constructor(
    private getContext: () => {
      accountId: string | null
      callbacks: SyncCallbacks | null
    }
  ) {}

  async pushRecoveryItems() {
    const { callbacks } = this.getContext()
    if (callbacks) {
      try {
        const entries = await readManualRecoveryEntries()
        await callbacks.onRecoveryItemsChanged(entries)
      } catch (error) {
        console.error('[RecoveryManager] Failed to push recovery entries change', error)
      }
    }
  }

  async retryRecoveryItem(itemId: string) {
    await removeManualRecoveryEntryByItemId(itemId)
    await this.pushRecoveryItems()
  }

  async forceOverwriteRecoveryItem(itemId: string) {
    const { accountId } = this.getContext()
    if (!accountId) return

    const localItem = getAutomergeItem(accountId, itemId)
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

    await removeManualRecoveryEntryByItemId(itemId)
    await this.pushRecoveryItems()
  }

  async forceDeleteRecoveryItem(itemId: string) {
    const { accountId } = this.getContext()
    if (!accountId) return

    const existing = getAutomergeItem(accountId, itemId)

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

    await removeManualRecoveryEntryByItemId(itemId)
    await this.pushRecoveryItems()
  }

  async dismissRecoveryItem(entryId: string) {
    await removeManualRecoveryEntryById(entryId)
    await this.pushRecoveryItems()
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    return await readManualRecoveryEntries()
  }
}
