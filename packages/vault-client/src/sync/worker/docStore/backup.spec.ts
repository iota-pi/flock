import { Repo } from '@automerge/automerge-repo/slim'
import type { AutomergeDocStore } from './AutomergeDocStore'
import { createTestDocStore } from '../__test__/testUtils'
import { AutomergeIndexManager } from './AutomergeIndexManager'
import { IndexStore } from '../stores/IndexStore'
import { ACCOUNT_INDEX_DOCUMENT_ID, BackupDocId } from '../utils/automerge'
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
    indexManager = new AutomergeIndexManager(accountId, indexStore)

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
    await indexManager.addAutomergeItemIdsToIndex([item.id])

    // Update metadata before backup
    await indexManager.updateAutomergeMetadata({ prayerGoal: 42 })

    // Export binaries
    const exported = await docStore.exportAllBinaries(indexManager)
    expect(Object.keys(exported.documents)).toContain(item.id)
    expect(Object.keys(exported.documents)).toContain(ACCOUNT_INDEX_DOCUMENT_ID)
    expect(exported.skipped).toEqual([])

    // Restore on a device without the item
    docStore = createTestDocStore(new Repo())
    await indexStore.clear()
    await indexManager.ensureIndexDocument()

    const retrievedBefore = await docStore.getAutomergeItem(item.id)
    expect(retrievedBefore).toBeNull()

    const metadataBefore = await indexManager.getAutomergeMetadata()
    expect(metadataBefore.prayerGoal).toBeUndefined()

    // Restore from binaries
    const restored = await docStore.restoreFromBinaries(exported.documents, indexManager)
    expect(restored).toContain(item.id)

    // Verify item restored
    const retrievedAfter = await docStore.getAutomergeItem(item.id)
    expect(retrievedAfter).toEqual(item)

    const itemIds = await indexManager.listAutomergeItemIds()
    expect(itemIds).toContain(item.id)

    // Verify metadata restored
    const metadataAfter = await indexManager.getAutomergeMetadata()
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
      await indexManager.addAutomergeItemIdsToIndex([id])
    }

    await createItem(backedUp)
    const exported = await docStore.exportAllBinaries(indexManager)
    await createItem(newer)

    await docStore.restoreFromBinaries(exported.documents, indexManager)

    const itemIds = await indexManager.listAutomergeItemIds()
    expect(itemIds).toContain(backedUp)
    expect(itemIds).toContain(newer)
  })

  it('leaves an item deleted since the backup deleted when restoring it', async () => {
    const id = 'test-item-deleted-later' as ItemId
    await docStore.changeDocument(id, doc => {
      doc.id = id
      doc.name = 'Deleted later'
    }, { createIfMissing: true })
    await indexManager.addAutomergeItemIdsToIndex([id])
    const exported = await docStore.exportAllBinaries(indexManager)

    await docStore.changeDocument(id, doc => {
      doc.deleted = true
    }, { knownToExist: true })
    await indexManager.removeAutomergeItemIdsFromIndex([id])

    await docStore.restoreFromBinaries(exported.documents, indexManager)

    expect(await indexManager.listAutomergeItemIds()).not.toContain(id)
    expect(await indexManager.listAutomergeTombstoneIds()).toContain(id)
  })

  it('should track skipped items when documents fail to load', async () => {
    // Add missing item to index
    await indexManager.addAutomergeItemIdsToIndex(['missing-item' as ItemId])

    vi.spyOn(docStore, 'findHandle').mockResolvedValue(undefined)

    const exported = await docStore.exportAllBinaries(indexManager)
    expect(exported.skipped).toContain('missing-item')
    expect(exported.documents['missing-item' as BackupDocId]).toBeUndefined()
  })
})
