import { IndexStore } from './IndexStore'
import {
  clearSyncMetadataInstancesCacheForTesting,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'

class MockLocalforage {
  private data = new Map<string, any>()
  public config?: Record<string, any>

  constructor(config?: Record<string, any>) {
    this.config = config
  }

  async getItem<T>(key: string): Promise<T | null> {
    return (this.data.get(key) as T) ?? null
  }

  async setItem<T>(key: string, value: T): Promise<T> {
    this.data.set(key, value)
    return value
  }

  async removeItem(key: string): Promise<void> {
    this.data.delete(key)
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}

const instances = new Map<string, MockLocalforage>()

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => {
      const key = `${config.name}#${config.storeName}`
      let inst = instances.get(key)
      if (!inst) {
        inst = new MockLocalforage(config)
        instances.set(key, inst)
      }
      return inst
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
      const legacyStore = new MockLocalforage({ name: LEGACY_DB_NAMES.INDEX_DOC, storeName: `index-${accountId}` })
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
