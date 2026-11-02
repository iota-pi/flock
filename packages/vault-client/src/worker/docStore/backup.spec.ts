import { Repo } from '@automerge/automerge-repo/slim'
import type { AutomergeDocStore } from './AutomergeDocStore'
import { createTestDocStore } from '../__test__/testUtils'
import { exportAllBinaries, exportSyncState, restoreFromBinaries, restoreSyncState } from './backup'
import { AutomergeIndexManager } from './AutomergeIndexManager'
import { IndexStore } from '../stores/IndexStore'
import { ACCOUNT_INDEX_DOCUMENT_ID, type BackupDocId } from '../utils/automerge'
import type { VaultDoc } from '../../shared/types'
import type { ItemId } from '@vault/shared'

const testRepo = new Repo()

describe('backup operations', () => {
  const accountId = 'test-account-id-backup'
  let docStore: AutomergeDocStore
  let indexManager: AutomergeIndexManager
  let indexStore: IndexStore

  beforeEach(async () => {
    indexStore = new IndexStore(accountId)
    docStore = createTestDocStore(testRepo)
    indexManager = new AutomergeIndexManager({ accountId, indexStore })

    await indexStore.clear()
    await indexManager.ensureIndexDocument()
  })

  it('should export all binaries and restore them successfully', async () => {
    const item: VaultDoc = {
      id: 'test-item-backup' as ItemId,
      type: 'person',
      name: 'Backup Prayer',
      description: 'A test prayer item for backup',
      created: Date.now(),
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
    }

    // Create item
    await docStore.changeDocument(
      item.id,
      doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true }
    )
    await indexManager.addItemIds([item.id])

    // Update metadata before backup
    await indexManager.updateMetadata({ prayerGoal: 42 })

    // Export binaries
    const exported = await exportAllBinaries(docStore, indexManager)
    expect(Object.keys(exported.documents)).toContain(item.id)
    expect(Object.keys(exported.documents)).toContain(ACCOUNT_INDEX_DOCUMENT_ID)
    expect(exported.skipped).toEqual([])

    // Restore on a device without the item
    docStore = createTestDocStore(new Repo())
    await indexStore.clear()
    await indexManager.ensureIndexDocument()

    const retrievedBefore = await docStore.getAutomergeItem(item.id)
    expect(retrievedBefore).toBeNull()

    const metadataBefore = await indexManager.getMetadata()
    expect(metadataBefore.prayerGoal).toBeUndefined()

    // Restore from binaries
    const restored = await restoreFromBinaries(docStore, exported.documents, indexManager)
    expect(restored).toContain(item.id)

    // Verify item restored
    const retrievedAfter = await docStore.getAutomergeItem(item.id)
    expect(retrievedAfter).toEqual(item)

    const itemIds = await indexManager.listItemIds()
    expect(itemIds).toContain(item.id)

    // Verify metadata restored
    const metadataAfter = await indexManager.getMetadata()
    expect(metadataAfter.prayerGoal).toBe(42)
  })

  it('keeps items created after the backup when restoring it', async () => {
    const backedUp = 'test-item-in-backup' as ItemId
    const newer = 'test-item-after-backup' as ItemId
    const createItem = async (id: ItemId) => {
      await docStore.changeDocument(id, doc => {
        doc.id = id
        doc.name = id
      }, { createIfMissing: true })
      await indexManager.addItemIds([id])
    }

    await createItem(backedUp)
    const exported = await exportAllBinaries(docStore, indexManager)
    await createItem(newer)

    await restoreFromBinaries(docStore, exported.documents, indexManager)

    const itemIds = await indexManager.listItemIds()
    expect(itemIds).toContain(backedUp)
    expect(itemIds).toContain(newer)
  })

  it('leaves an item deleted since the backup deleted when restoring it', async () => {
    const id = 'test-item-deleted-later' as ItemId
    await docStore.changeDocument(id, doc => {
      doc.id = id
      doc.name = 'Deleted later'
    }, { createIfMissing: true })
    await indexManager.addItemIds([id])
    const exported = await exportAllBinaries(docStore, indexManager)

    await docStore.changeDocument(id, doc => {
      doc.deleted = true
    }, { knownToExist: true })
    await indexManager.removeItemIds([id])

    await restoreFromBinaries(docStore, exported.documents, indexManager)

    expect(await indexManager.listItemIds()).not.toContain(id)
    expect(await indexManager.listTombstoneIds()).toContain(id)
  })

  it('should track skipped items when documents fail to load', async () => {
    // Add missing item to index
    await indexManager.addItemIds(['missing-item' as ItemId])

    vi.spyOn(docStore, 'findHandle').mockResolvedValue(undefined)

    const exported = await exportAllBinaries(docStore, indexManager)
    expect(exported.skipped).toContain('missing-item')
    expect(exported.documents['missing-item' as BackupDocId]).toBeUndefined()
  })
})

describe('sync state backup', () => {
  let pullQueueManager: any
  let wal: any
  let snapshotManager: any

  beforeEach(() => {
    pullQueueManager = {
      cursors: { exportCursors: vi.fn().mockReturnValue([['item-1', 5]]) },
      importCursors: vi.fn().mockResolvedValue(undefined),
    }
    wal = {
      readAll: vi.fn().mockResolvedValue(new Map([['item-1', [{ data: new Uint8Array([1, 2, 3]) }]]])),
      append: vi.fn().mockResolvedValue(undefined),
    }
    snapshotManager = {
      tracker: {
        exportLastModified: vi.fn().mockReturnValue([['item-1', 1000]]),
        importLastModified: vi.fn().mockResolvedValue(undefined),
      },
    }
  })

  it('exports cursors, unpushed WAL entries and modification times', async () => {
    const state = await exportSyncState(pullQueueManager, wal, snapshotManager)

    expect(state).toEqual({
      cursors: [['item-1', 5]],
      pendingSync: [['item-1', [new Uint8Array([1, 2, 3]).toBase64()]]],
      lastModified: [['item-1', 1000]],
    })
  })

  it('restores the state it exported', async () => {
    const message = new Uint8Array([4, 5, 6])

    await restoreSyncState(pullQueueManager, wal, snapshotManager, {
      cursors: [['item-1' as ItemId, 5]],
      pendingSync: [['item-1' as ItemId, [message.toBase64()]]],
      lastModified: [['item-1' as ItemId, 1000]],
    })

    expect(pullQueueManager.importCursors).toHaveBeenCalledWith([['item-1', 5]])
    expect(wal.append).toHaveBeenCalledWith('item-1', message)
    expect(snapshotManager.tracker.importLastModified).toHaveBeenCalledWith([['item-1', 1000]])
  })

  it('leaves out the parts a backup does not carry', async () => {
    await restoreSyncState(pullQueueManager, wal, snapshotManager, {})

    expect(pullQueueManager.importCursors).not.toHaveBeenCalled()
    expect(wal.append).not.toHaveBeenCalled()
    expect(snapshotManager.tracker.importLastModified).not.toHaveBeenCalled()
  })
})
