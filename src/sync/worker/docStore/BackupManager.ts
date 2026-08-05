import * as Automerge from '@automerge/automerge/slim'
import type { ItemId } from '../../../shared/schemas/items'
import { encodeBytesToBase64, decodeBase64ToBytes } from '../utils/base64Utils'
import { ACCOUNT_INDEX_DOCUMENT_ID, type BackupDocId } from '../utils/automerge'
import { normalizeItemId, type AutomergeDocStore } from './AutomergeDocStore'
import type { AutomergeIndexManager } from './AutomergeIndexManager'

export class BackupManager {
  constructor(
    private readonly docStore: AutomergeDocStore,
    private readonly indexManager: AutomergeIndexManager
  ) {}

  async exportAllBinaries(): Promise<Partial<Record<BackupDocId, string>>> {
    const exported: Partial<Record<BackupDocId, string>> = {}

    for (const itemId of await this.indexManager.listAutomergeItemIds()) {
      const handle = await this.docStore.findHandle(itemId)
      if (!handle || !handle.isReady()) continue

      const doc = handle.doc()
      if (!doc) continue

      const binary = Automerge.save(doc)
      exported[itemId] = encodeBytesToBase64(binary)
    }

    const indexDoc = await this.indexManager.getIndexSnapshot()
    const indexBinary = new TextEncoder().encode(JSON.stringify(indexDoc))
    exported[ACCOUNT_INDEX_DOCUMENT_ID] = encodeBytesToBase64(indexBinary)

    return exported
  }

  async restoreFromBinaries(items: Partial<Record<BackupDocId, string>>): Promise<ItemId[]> {
    const restoredItemIds: ItemId[] = []

    const encodedIndex = items[ACCOUNT_INDEX_DOCUMENT_ID]
    if (encodedIndex && typeof encodedIndex === 'string') {
      try {
        const indexBinary = decodeBase64ToBytes(encodedIndex)
        const indexDoc = JSON.parse(new TextDecoder().decode(indexBinary))
        if (indexDoc && typeof indexDoc === 'object') {
          await this.indexManager.indexStore.saveIndex(indexDoc)
        }
      } catch (err) {
        console.error('[backup] Failed to restore index metadata from backup', err)
      }
    }

    for (const [itemId, encodedBinary] of Object.entries(items)) {
      if (itemId === ACCOUNT_INDEX_DOCUMENT_ID) continue
      if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) continue

      const normalizedItemId = normalizeItemId(itemId)
      if (!normalizedItemId) continue

      await this.docStore.hydrateAutomergeDocumentBinary(
        normalizedItemId,
        decodeBase64ToBytes(encodedBinary)
      )

      restoredItemIds.push(normalizedItemId)
    }

    await this.indexManager.addAutomergeItemIdsToIndex(restoredItemIds)
    return restoredItemIds
  }
}
