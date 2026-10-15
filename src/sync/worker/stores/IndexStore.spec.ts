import { IndexStore } from './IndexStore'
import {
  clearSyncMetadataInstancesCacheForTesting,
  SYNC_METADATA_KEYS,
} from './syncMetadataStorage'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'

import { createMockLocalForagePool } from '../__test__/testUtils'

const pool = createMockLocalForagePool()
const instances = pool.instances

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => {
      return pool.createInstance(config)
    }),
  },
}))

vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

describe('IndexStore', () => {
  let store: IndexStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    instances.clear()
    clearSyncMetadataInstancesCacheForTesting()
    store = new IndexStore(accountId)
  })

  it('saves and loads index document correctly in consolidated store', async () => {
    const doc = { itemIds: ['item-1', 'item-2'] } as unknown as AutomergeIndexDocument
    await store.saveIndex(doc)
    const loaded = await store.getIndex()
    expect(loaded).toEqual(doc)

    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.INDEX_DOC)).toEqual(doc)
  })

  it('clears index document without affecting other keys', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.CURSORS, [['item-1', 1]])

    const doc = { itemIds: ['item-1'] } as unknown as AutomergeIndexDocument
    await store.saveIndex(doc)
    await store.clear()

    const loaded = await store.getIndex()
    expect(loaded).toBeNull()

    // Cursors should still exist
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual([['item-1', 1]])
  })

})
