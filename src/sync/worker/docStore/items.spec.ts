import { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeDocStore, normalizeItemSnapshot } from './AutomergeDocStore'
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

  it('should self-heal a snapshot with topic type containing leftover group fields', () => {
    const rawSnapshot = {
      id: 'converted-topic-1',
      type: 'topic',
      name: 'Global Topic',
      description: 'Formerly a group',
      created: 10000,
      archived: false,
      prayerFrequency: 'none',
      notes: [],
      prayedFor: [],
      members: ['member-1'],
      memberPrayerFrequency: 'daily',
      memberPrayerTarget: 'all',
    }

    const normalized = normalizeItemSnapshot('converted-topic-1' as ItemId, rawSnapshot)
    expect(normalized).not.toBeNull()
    expect(normalized?.type).toBe('topic')
    expect(normalized?.name).toBe('Global Topic')
    expect((normalized as any).members).toBeUndefined()
    expect((normalized as any).memberPrayerFrequency).toBeUndefined()
    expect((normalized as any).memberPrayerTarget).toBeUndefined()
  })
})
