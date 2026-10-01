import { IndexStore } from './IndexStore'
import {
  clearSyncMetadataInstancesCacheForTesting,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'

import {
  MockLocalforage,
  createMockLocalForage,
  createMockLocalForagePool,
} from '../__test__/testUtils'

const pool = createMockLocalForagePool()
const instances = pool.instances

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => {
      return pool.createInstance(config)
    }),
  },
}))

vi.mock('../../../utils/storageManager', () => ({
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

  it('migrates legacy index database to consolidated storage', async () => {
    const originalIndexedDb = (globalThis as any).indexedDB
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: LEGACY_DB_NAMES.INDEX_DOC }]),
    }
    try {
      const legacyStoreKey = `${LEGACY_DB_NAMES.INDEX_DOC}#index-${accountId}`
      const legacyStore = createMockLocalForage({ name: LEGACY_DB_NAMES.INDEX_DOC, storeName: `index-${accountId}` })
      const legacyDoc = { itemIds: ['legacy-1'] } as unknown as AutomergeIndexDocument
      await legacyStore.setItem(LEGACY_KEYS.INDEX_DOC, legacyDoc)
      instances.set(legacyStoreKey, legacyStore)

      const loaded = await store.getIndex()
      expect(loaded).toEqual(legacyDoc)

      const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
      expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.INDEX_DOC)).toEqual(legacyDoc)
      expect(await legacyStore.getItem(LEGACY_KEYS.INDEX_DOC)).toBeNull()
    } finally {
      if (originalIndexedDb === undefined) {
        delete (globalThis as any).indexedDB
      } else {
        ;(globalThis as any).indexedDB = originalIndexedDb
      }
    }
  })
})
