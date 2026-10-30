import {
  getSyncMetadataDBName,
  getSyncMetadataStorage,
  clearSyncMetadataStorage,
  SYNC_METADATA_STORE_NAME,
  ScopedMetadataStore,
  type ScopedMetadataStoreOptions,
} from './syncMetadataStorage'
import localforage from 'localforage'
import * as storageManager from '../../utils/storageManager'

import {
  MockLocalforage,
  createMockLocalForage,
  mockLocalForage,
} from '../__test__/testUtils'
import { clearAccountStoreInstancesCacheForTesting } from '../../shared/createAccountStore'

describe('syncMetadataStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLocalForage(config => createMockLocalForage(config))
    clearAccountStoreInstancesCacheForTesting()
  })

  it('generates consistent database name for account', () => {
    expect(getSyncMetadataDBName('acc-123')).toBe('test-vault-sync-metadata-acc-123')
  })

  it('reuses same LocalForage instance for the same accountId', () => {
    const store1 = getSyncMetadataStorage('acc-1')
    const store2 = getSyncMetadataStorage('acc-1')

    expect(store1).toBe(store2)
    expect(localforage.createInstance).toHaveBeenCalledTimes(1)
    expect(localforage.createInstance).toHaveBeenCalledWith({
      name: 'test-vault-sync-metadata-acc-1',
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

  it('clearAccountStoreInstancesCacheForTesting resets cache', () => {
    const store1 = getSyncMetadataStorage('acc-1')
    clearAccountStoreInstancesCacheForTesting()
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
    accountId: string,
    options?: Partial<ScopedMetadataStoreOptions<TestData>>
  ) {
    super(accountId, {
      metadataKey: 'testKey',
      ...options,
    })
  }

  async load(): Promise<TestData | null> {
    return this.getScopedData()
  }

  async save(data: TestData): Promise<void> {
    await this.setScopedData(data)
  }
}

describe('ScopedMetadataStore', () => {
  const accountId = 'account-scoped-1'
  let store: TestScopedStore

  beforeEach(() => {
    vi.clearAllMocks()
    mockLocalForage(config => createMockLocalForage(config))
    clearAccountStoreInstancesCacheForTesting()
    store = new TestScopedStore(accountId)
  })

  it('initializes with accountId string and uses consolidated metadata storage', async () => {
    await store.save({ value: 'hello' })
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    expect(await consolidated.getItem('testKey')).toEqual({ value: 'hello' })
  })

  it('loads scoped data when present in primary metadataKey', async () => {
    await store.save({ value: 'existing' })
    const data = await store.load()
    expect(data).toEqual({ value: 'existing' })
  })

  it('returns null when the key is missing', async () => {
    expect(await store.load()).toBeNull()
  })

  it('returns null without rewriting the value when normalize rejects it', async () => {
    const strictStore = new TestScopedStore(accountId, {
      normalize: (raw: unknown) => (typeof raw === 'object' ? raw as TestData : null),
    })
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    await consolidated.setItem('testKey', 'raw-string-value')

    expect(await strictStore.load()).toBeNull()
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
  it('writes and clears through runStorageOperation', async () => {
    const runStorageOperationSpy = vi.spyOn(storageManager, 'runStorageOperation')

    await store.save({ value: 'tracked' })
    expect(runStorageOperationSpy).toHaveBeenCalledTimes(1)

    await store.clear()
    expect(runStorageOperationSpy).toHaveBeenCalledTimes(2)
  })

  it('testStorageAvailable returns true when storage writes succeed', async () => {
    expect(await store.testStorageAvailable()).toBe(true)
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    expect(consolidated.data.size).toBe(0)
  })

  it('testStorageAvailable surfaces QuotaExceededError when storage write fails', async () => {
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
    vi.spyOn(consolidated, 'setItem').mockRejectedValueOnce(quotaErr)

    await expect(store.testStorageAvailable()).rejects.toThrow('Quota exceeded')
  })
})
