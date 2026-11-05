import * as Automerge from '@automerge/automerge/slim'
import { type ItemId, ItemIdSchema } from '@vault/shared'
import { ACCOUNT_INDEX_DOCUMENT_ID, type BackupDocId } from '../utils/automerge'
import type { AutomergeDocStore } from './AutomergeDocStore'
import type { AutomergeIndexManager } from './AutomergeIndexManager'
import type { SnapshotManager } from '../SnapshotManager'
import type { BackupSyncState } from '../../shared/backupSyncState'
import { createLogger } from '../../utils/logger'

const log = createLogger('backup')

export async function exportAllBinaries(
  docStore: AutomergeDocStore,
  indexManager: AutomergeIndexManager,
): Promise<{
  documents: Partial<Record<BackupDocId, string>>
  skipped: ItemId[]
}> {
  const exported: Partial<Record<BackupDocId, string>> = {}
  const skipped: ItemId[] = []

  for (const itemId of await indexManager.listItemIds()) {
    const handle = await docStore.findHandle(itemId, { knownToExist: true })
    if (!handle?.isReady()) {
      log.warn(`Skipping item ${itemId}: document could not be loaded in time`)
      skipped.push(itemId)
      continue
    }

    const doc = handle.doc()
    if (!doc) {
      log.warn(`Skipping item ${itemId}: document handle doc is empty`)
      skipped.push(itemId)
      continue
    }

    const binary = Automerge.save(doc)
    exported[itemId] = binary.toBase64()
  }

  const indexDoc = await indexManager.getIndexSnapshot()
  const indexBinary = new TextEncoder().encode(JSON.stringify(indexDoc))
  exported[ACCOUNT_INDEX_DOCUMENT_ID] = indexBinary.toBase64()

  return { documents: exported, skipped }
}

export async function restoreFromBinaries(
  docStore: AutomergeDocStore,
  items: Partial<Record<BackupDocId, string>>,
  indexManager: AutomergeIndexManager,
): Promise<ItemId[]> {
  const restoredItemIds: ItemId[] = []
  const activeItemIds: ItemId[] = []
  const deletedItemIds: ItemId[] = []

  const encodedIndex = items[ACCOUNT_INDEX_DOCUMENT_ID]
  if (encodedIndex && typeof encodedIndex === 'string') {
    try {
      const indexBinary = Uint8Array.fromBase64(encodedIndex)
      const indexDoc = JSON.parse(new TextDecoder().decode(indexBinary))
      if (indexDoc && typeof indexDoc === 'object') {
        await indexManager.mergeIndex(indexDoc)
      }
    } catch (err) {
      log.error('Failed to restore index metadata from backup', err)
    }
  }

  for (const [rawItemId, encodedBinary] of Object.entries(items)) {
    if (rawItemId === ACCOUNT_INDEX_DOCUMENT_ID) continue
    if (typeof encodedBinary !== 'string' || encodedBinary.length === 0) continue

    const parsedItemId = ItemIdSchema.safeParse(rawItemId)
    if (!parsedItemId.success) continue
    const itemId = parsedItemId.data

    try {
      const result = await docStore.hydrateAutomergeDocumentBinary(itemId, Uint8Array.fromBase64(encodedBinary))
      restoredItemIds.push(itemId)
      // Merged with the local doc, which may have been deleted since the backup
      if (result.isDeleted) {
        deletedItemIds.push(itemId)
      } else {
        activeItemIds.push(itemId)
      }
    } catch (err) {
      log.error(`Failed to restore document for ${itemId}`, err)
    }
  }

  await indexManager.addItemIds(activeItemIds)
  if (deletedItemIds.length > 0) {
    await indexManager.removeItemIds(deletedItemIds)
  }
  return restoredItemIds
}

/** The sync state a backup carries: modification times. A restored doc holds its own unpushed changes. */
export function exportSyncState(snapshotManager: SnapshotManager): BackupSyncState {
  return { cursors: [], lastModified: snapshotManager.tracker.exportLastModified() }
}

/**
 * Restores the sync state `exportSyncState` exported. Cursors and `pendingSync` in older backups are
 * ignored: a backup's position says nothing about the log, and its docs hold those changes.
 */
export async function restoreSyncState(
  snapshotManager: SnapshotManager,
  state: Partial<BackupSyncState>,
): Promise<void> {
  if (state.lastModified) await snapshotManager.tracker.importLastModified(state.lastModified)
}
