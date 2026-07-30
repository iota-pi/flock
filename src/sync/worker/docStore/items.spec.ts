import { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeDocStore } from './AutomergeDocStore'
import type { Item } from 'src/state/items'
import { ItemId } from 'src/shared/schemas/items'

const testRepo = new Repo()

describe('items operations', () => {
  let docStore: AutomergeDocStore

  beforeEach(async () => {
    docStore = new AutomergeDocStore(testRepo)
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

    const created = await docStore.changeDocument(
      item.id,
      (doc: any) => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true }
    )

    expect(created).toBe(true)

    const retrieved = await docStore.getAutomergeItem(item.id)
    expect(retrieved).toEqual(item)
  })

  it('should remove an item successfully', async () => {
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

    await docStore.changeDocument(
      item.id,
      (doc: any) => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true }
    )

    await docStore.removeAutomergeItem(item.id)

    const retrieved = await docStore.getAutomergeItem(item.id)
    expect(retrieved).toBeNull()
  })
})
