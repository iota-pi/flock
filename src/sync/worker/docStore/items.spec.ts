import { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeDocStore } from './AutomergeDocStore'
import type { Item } from '../../../state/items'
import { ItemId } from '../../../shared/schemas/items'

const testRepo = new Repo()

vi.mock('../automergeRepo', () => {
  return {
    getAutomergeRepo: () => testRepo,
    getAutomergeDBName: () => 'flock-automerge-test-db-items',
    closeAutomergeRepo: vi.fn(),
  }
})

describe('items operations', () => {
  const accountId = 'test-account-id-items'
  let docStore: AutomergeDocStore

  beforeEach(async () => {
    docStore = new AutomergeDocStore(accountId, testRepo)
    await docStore.clear()
    await docStore.initialize()
  })

  it('should create and retrieve an item successfully', async () => {
    const item: Item = {
      id: 'test-item-id' as ItemId,
      type: 'person',
      name: 'Test Prayer',
      description: 'A test prayer item',
      created: Date.now(),
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
    }

    const created = await docStore.withAutomergeDocumentChange(
      item.id,
      (doc: any) => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true, initialValue: item as any }
    )

    expect(created).toBe(true)

    const retrieved = await docStore.getAutomergeItem(item.id)
    expect(retrieved).toEqual(item)
  })

  it('should remove an item and remove it from the index', async () => {
    const item: Item = {
      id: 'test-item-remove' as ItemId,
      type: 'person',
      name: 'Test Prayer Remove',
      description: 'A test prayer item to remove',
      created: Date.now(),
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
    }

    await docStore.withAutomergeDocumentChange(
      item.id,
      (doc: any) => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true, initialValue: item as any }
    )

    const itemIdsBefore = await docStore.listAutomergeItemIds()
    expect(itemIdsBefore).toContain(item.id)

    await docStore.removeAutomergeItem(item.id)

    const itemIdsAfter = await docStore.listAutomergeItemIds()
    expect(itemIdsAfter).not.toContain(item.id)

    const retrieved = await docStore.getAutomergeItem(item.id)
    expect(retrieved).toBeNull()
  })
})
