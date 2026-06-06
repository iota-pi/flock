import { Repo } from '@automerge/automerge-repo/slim'

import {
  clearAutomergeDocStore,
  initializeAutomergeDocStore,
  listAutomergeItemIds,
} from './indexManager'
import {
  getAutomergeItem,
  removeAutomergeItem,
  withAutomergeDocumentChange,
} from './items'
import type { Item } from '../../state/items'
import { ItemId } from 'src/shared/schemas/items'

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

  beforeEach(async () => {
    await clearAutomergeDocStore(accountId)
    await initializeAutomergeDocStore(accountId)
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

    const created = await withAutomergeDocumentChange(
      accountId,
      item.id,
      doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true, initialValue: item as any }
    )

    expect(created).toBe(true)

    const retrieved = await getAutomergeItem(accountId, item.id)
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

    await withAutomergeDocumentChange(
      accountId,
      item.id,
      doc => {
        for (const [key, value] of Object.entries(item)) {
          doc[key] = value
        }
      },
      { createIfMissing: true, initialValue: item as any }
    )

    const itemIdsBefore = await listAutomergeItemIds(accountId)
    expect(itemIdsBefore).toContain(item.id)

    await removeAutomergeItem(accountId, item.id)

    const itemIdsAfter = await listAutomergeItemIds(accountId)
    expect(itemIdsAfter).not.toContain(item.id)

    const retrieved = await getAutomergeItem(accountId, item.id)
    expect(retrieved).toBeNull()
  })
})
