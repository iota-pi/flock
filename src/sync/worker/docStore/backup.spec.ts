import { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeDocStore } from './AutomergeDocStore'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'
import type { Item } from '../../../state/items'
import type { ItemId } from '../../../shared/schemas/items'

const testRepo = new Repo()

vi.mock('../automergeRepo', () => {
  return {
    getAutomergeRepo: () => testRepo,
    getAutomergeDBName: () => 'flock-automerge-test-db-backup',
    closeAutomergeRepo: vi.fn(),
  }
})

describe('backup operations', () => {
  const accountId = 'test-account-id-backup'
  let docStore: AutomergeDocStore

  beforeEach(async () => {
    docStore = new AutomergeDocStore(accountId, testRepo)
    await docStore.clear()
    await docStore.initialize()
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
    await docStore.withAutomergeDocumentChange(
      item.id,
      doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true, initialValue: item as any }
    )

    // Update metadata before backup
    await docStore.updateAutomergeMetadata({ prayerGoal: 42 })

    // Export binaries
    const exported = await docStore.exportAllBinaries()
    expect(Object.keys(exported)).toContain(item.id)
    expect(Object.keys(exported)).toContain(ACCOUNT_INDEX_DOCUMENT_ID)

    // Clean current state
    await docStore.clear()
    await docStore.initialize()

    const retrievedBefore = await docStore.getAutomergeItem(item.id)
    expect(retrievedBefore).toBeNull()

    const metadataBefore = await docStore.getAutomergeMetadata()
    expect(metadataBefore.prayerGoal).toBeUndefined()

    // Restore from binaries
    const restored = await docStore.restoreFromBinaries(exported)
    expect(restored).toContain(item.id)

    // Verify item restored
    const retrievedAfter = await docStore.getAutomergeItem(item.id)
    expect(retrievedAfter).toEqual(item)

    const itemIds = await docStore.listAutomergeItemIds()
    expect(itemIds).toContain(item.id)

    // Verify metadata restored
    const metadataAfter = await docStore.getAutomergeMetadata()
    expect(metadataAfter.prayerGoal).toBe(42)
  })
})
