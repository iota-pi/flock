import { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeDocStore } from './AutomergeDocStore'
import { AutomergeIndexManager } from './AutomergeIndexManager'
import { BackupManager } from './BackupManager'
import { IndexStore } from '../stores/IndexStore'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../utils/automerge'
import type { Item } from '../../../state/items'
import type { ItemId } from '../../../shared/schemas/items'

const testRepo = new Repo()

describe('backup operations', () => {
  const accountId = 'test-account-id-backup'
  let docStore: AutomergeDocStore
  let indexManager: AutomergeIndexManager
  let backupManager: BackupManager
  let indexStore: IndexStore

  beforeEach(async () => {
    indexStore = new IndexStore(accountId)
    docStore = new AutomergeDocStore(testRepo)
    indexManager = new AutomergeIndexManager(accountId, indexStore)
    backupManager = new BackupManager(docStore, indexManager)

    await indexStore.clear()
    await indexManager.ensureIndexDocument()
  })

  it('should export all binaries and restore them successfully', async () => {
    const item: Item = {
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
    const exported = await backupManager.exportAllBinaries()
    expect(Object.keys(exported.documents)).toContain(item.id)
    expect(Object.keys(exported.documents)).toContain(ACCOUNT_INDEX_DOCUMENT_ID)
    expect(exported.skipped).toEqual([])

    // Clean current state
    await docStore.removeAutomergeItem(item.id)
    await indexStore.clear()
    await indexManager.ensureIndexDocument()

    const retrievedBefore = await docStore.getAutomergeItem(item.id)
    expect(retrievedBefore).toBeNull()

    const metadataBefore = await indexManager.getAutomergeMetadata()
    expect(metadataBefore.prayerGoal).toBeUndefined()

    // Restore from binaries
    const restored = await backupManager.restoreFromBinaries(exported.documents)
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

  it('should track skipped items when documents fail to load', async () => {
    // Add missing item to index
    await indexManager.addAutomergeItemIdsToIndex(['missing-item' as ItemId])

    vi.spyOn(docStore, 'findHandle').mockResolvedValue(undefined)

    const exported = await backupManager.exportAllBinaries()
    expect(exported.skipped).toContain('missing-item')
    expect(exported.documents['missing-item']).toBeUndefined()
  })
})
