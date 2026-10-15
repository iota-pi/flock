import {
  getSyncMetadataDBName,
  getSyncMetadataStorage,
  clearSyncMetadataInstancesCacheForTesting,
  clearSyncMetadataStorage,
  SYNC_METADATA_STORE_NAME,
  ScopedMetadataStore,
  type ScopedMetadataStoreOptions,
} from './syncMetadataStorage'
import localforage from 'localforage'

import {
  MockLocalforage,
  createMockLocalForage,
} from '../__test__/testUtils'

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => createMockLocalForage(config)),
  },
}))

vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

describe('syncMetadataStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSyncMetadataInstancesCacheForTesting()
  })

  it('generates consistent database name for account', () => {
    expect(getSyncMetadataDBName('acc-123')).toBe('flock-sync-metadata-acc-123')
  })


  it('reuses same LocalForage instance for the same accountId', () => {
    const store1 = getSyncMetadataStorage('acc-1')
    const store2 = getSyncMetadataStorage('acc-1')

    expect(store1).toBe(store2)
    expect(localforage.createInstance).toHaveBeenCalledTimes(1)
    expect(localforage.createInstance).toHaveBeenCalledWith({
      name: 'flock-sync-metadata-acc-1',
      storeName: SYNC_METADATA_STORE_NAME,
      description: expect.any(String),
    })
  })

  it('creates separate instances for different accountIds', () => {
    const store1 = getSyncMetadataStorage('acc-1')
    const store2 = getSyncMetadataStorage('acc-2')

    expect(store1).not.toBe(store2)
    expect(localforage.createInstance).toHaveBeenCalledTimes(2)
  })

  it('clearSyncMetadataInstancesCacheForTesting resets cache', () => {
    const store1 = getSyncMetadataStorage('acc-1')
    clearSyncMetadataInstancesCacheForTesting()
    const store2 = getSyncMetadataStorage('acc-1')

    expect(store1).not.toBe(store2)
    expect(localforage.createInstance).toHaveBeenCalledTimes(2)
  })

  it('clearSyncMetadataStorage clears account metadata storage', async () => {
    const store = getSyncMetadataStorage('acc-1') as unknown as MockLocalforage
    await store.setItem('cursors', [['item-1', 100]])
    expect(store.data.size).toBe(1)

    await clearSyncMetadataStorage('acc-1')
    expect(store.data.size).toBe(0)
  })

})

interface TestData {
  value: string
}

class TestScopedStore extends ScopedMetadataStore<TestData> {
  constructor(
    accountIdOrStore: string | LocalForage,
    options?: Partial<ScopedMetadataStoreOptions<TestData>>
  ) {
    super(accountIdOrStore, {
      metadataKey: 'testKey',
      ...options,
    })
  }
}

describe('ScopedMetadataStore', () => {
  const accountId = 'account-scoped-1'
  let store: TestScopedStore

  beforeEach(() => {
    vi.clearAllMocks()
    clearSyncMetadataInstancesCacheForTesting()
    store = new TestScopedStore(accountId)
  })

  it('initializes with accountId string and uses consolidated metadata storage', async () => {
    await store.setScopedData({ value: 'hello' })
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    expect(await consolidated.getItem('testKey')).toEqual({ value: 'hello' })
  })

  it('initializes with a direct LocalForage instance', async () => {
    const customInstance = createMockLocalForage({ name: 'custom-db', storeName: 'custom-store' })
    const customStore = new TestScopedStore(customInstance as unknown as LocalForage)

    await customStore.setScopedData({ value: 'direct' })
    expect(await customInstance.getItem('testKey')).toEqual({ value: 'direct' })
  })

  it('loads scoped data when present in primary metadataKey', async () => {
    await store.setScopedData({ value: 'existing' })
    const data = await store.getScopedData()
    expect(data).toEqual({ value: 'existing' })
  })


  it('returns null when the key is missing', async () => {
    expect(await store.getScopedData()).toBeNull()
  })

  it('returns null without rewriting the value when normalize rejects it', async () => {
    const strictStore = new TestScopedStore(accountId, {
      normalize: (raw: unknown) => (typeof raw === 'object' ? raw as TestData : null),
    })
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    await consolidated.setItem('testKey', 'raw-string-value')

    expect(await strictStore.getScopedData()).toBeNull()
    expect(await consolidated.getItem('testKey')).toBe('raw-string-value')
  })

  it('clears scoped data without wiping other keys in storage', async () => {
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    await consolidated.setItem('unrelatedKey', 'important-data')
    await consolidated.setItem('testKey', { value: 'to-be-cleared' })

    await store.clear()

    expect(await consolidated.getItem('testKey')).toBeNull()
    expect(await consolidated.getItem('unrelatedKey')).toBe('important-data')
  })
})
