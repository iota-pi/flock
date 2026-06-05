import { Repo } from '@automerge/automerge-repo/slim'

import {
  clearAutomergeDocStore,
  initializeAutomergeDocStore,
} from './core'
import {
  exportAllBinaries,
  restoreFromBinaries,
} from './backup'
import {
  getAutomergeItem,
  withAutomergeDocumentChange,
} from './items'
import { listAutomergeItemIds } from './indexManager'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../automergeConstants'
import type { Item } from '../../state/items'

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

  beforeEach(async () => {
    await clearAutomergeDocStore(accountId)
    await initializeAutomergeDocStore(accountId)
  })

  it('should export all binaries and restore them successfully', async () => {
    const item: Item = {
      id: 'test-item-backup',
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

    // Export binaries
    const exported = await exportAllBinaries(accountId)
    expect(Object.keys(exported)).toContain(item.id)
    expect(Object.keys(exported)).toContain(ACCOUNT_INDEX_DOCUMENT_ID)

    // Clean current state
    await clearAutomergeDocStore(accountId)
    await initializeAutomergeDocStore(accountId)

    const retrievedBefore = await getAutomergeItem(accountId, item.id)
    expect(retrievedBefore).toBeNull()

    // Restore from binaries
    const restored = await restoreFromBinaries(accountId, exported)
    expect(restored).toContain(item.id)

    // Verify item restored
    const retrievedAfter = await getAutomergeItem(accountId, item.id)
    expect(retrievedAfter).toEqual(item)

    const itemIds = await listAutomergeItemIds(accountId)
    expect(itemIds).toContain(item.id)
  })
})
