import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getSyncMetadataDBName,
  getSyncMetadataStorage,
  clearSyncMetadataInstancesCacheForTesting,
  clearSyncMetadataStorage,
  clearLegacySyncDatabases,
  SYNC_METADATA_STORE_NAME,
  LEGACY_DB_NAMES,
  ScopedMetadataStore,
  type ScopedMetadataStoreOptions,
} from './syncMetadataStorage'
import localforage from 'localforage'

class MockLocalforage {
  public data = new Map<string, any>()
  public config: Record<string, any>

  constructor(config: Record<string, any>) {
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

const mockInstances = new Map<string, MockLocalforage>()
const createdInstances: MockLocalforage[] = []

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => {
      const key = `${config.name}#${config.storeName}`
      const existing = mockInstances.get(key)
      if (existing) {
        createdInstances.push(existing)
        return existing
      }
      const inst = new MockLocalforage(config)
      createdInstances.push(inst)
      return inst
    }),
  },
}))

vi.mock('../../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

describe('syncMetadataStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInstances.clear()
    createdInstances.length = 0
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

  it('clearLegacySyncDatabases clears all 4 legacy stores', async () => {
    await clearLegacySyncDatabases('acc-legacy')

    const createdConfigs = createdInstances.map(i => i.config)
    expect(createdConfigs).toContainEqual({
      name: LEGACY_DB_NAMES.CURSORS,
      storeName: 'cursors-acc-legacy',
    })
    expect(createdConfigs).toContainEqual({
      name: LEGACY_DB_NAMES.INDEX_DOC,
      storeName: 'index-acc-legacy',
    })
    expect(createdConfigs).toContainEqual({
      name: LEGACY_DB_NAMES.LAST_MODIFIED,
      storeName: 'last-modified-acc-legacy',
    })
    expect(createdConfigs).toContainEqual({
      name: LEGACY_DB_NAMES.SYNCED_HEADS,
      storeName: 'synced-heads-acc-legacy',
    })
  })
})

interface TestData {
  value: string
  upgraded?: boolean
}

class TestScopedStore extends ScopedMetadataStore<TestData> {
  constructor(
    accountIdOrStore: string | LocalForage,
    options?: Partial<ScopedMetadataStoreOptions<TestData>>
  ) {
    super(accountIdOrStore, {
      metadataKey: 'testKey',
      legacyKey: 'testLegacyKey',
      legacyDbName: 'test-legacy-db',
      legacyStorePrefix: 'test-store',
      storeLabel: 'TestScopedStore',
      ...options,
    })
  }
}

describe('ScopedMetadataStore', () => {
  const accountId = 'account-scoped-1'
  let store: TestScopedStore

  beforeEach(() => {
    vi.clearAllMocks()
    mockInstances.clear()
    createdInstances.length = 0
    clearSyncMetadataInstancesCacheForTesting()
    store = new TestScopedStore(accountId)
  })

  it('initializes with accountId string and uses consolidated metadata storage', async () => {
    await store.setScopedData({ value: 'hello' })
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    expect(await consolidated.getItem('testKey')).toEqual({ value: 'hello' })
  })

  it('initializes with a direct LocalForage instance', async () => {
    const customInstance = new MockLocalforage({ name: 'custom-db', storeName: 'custom-store' })
    const customStore = new TestScopedStore(customInstance as unknown as LocalForage)

    await customStore.setScopedData({ value: 'direct' })
    expect(await customInstance.getItem('testKey')).toEqual({ value: 'direct' })
  })

  it('loads scoped data when present in primary metadataKey', async () => {
    await store.setScopedData({ value: 'existing' })
    const data = await store.getScopedData()
    expect(data).toEqual({ value: 'existing' })
  })

  it('normalizes data and upgrades in-place when shouldUpgradeInPlace is true', async () => {
    const upgradingStore = new TestScopedStore(accountId, {
      normalize: (raw: unknown) => {
        if (typeof raw === 'string') {
          return { value: raw, upgraded: true }
        }
        return raw as TestData
      },
      shouldUpgradeInPlace: (raw: unknown) => typeof raw === 'string',
    })

    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    await consolidated.setItem('testKey', 'raw-string-value')

    const data = await upgradingStore.getScopedData()
    expect(data).toEqual({ value: 'raw-string-value', upgraded: true })

    // Consolidated storage should now contain the upgraded object
    expect(await consolidated.getItem('testKey')).toEqual({ value: 'raw-string-value', upgraded: true })
  })

  it('migrates from in-store legacyKey (Tier 1)', async () => {
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    await consolidated.setItem('testLegacyKey', { value: 'from-tier-1' })

    const data = await store.getScopedData()
    expect(data).toEqual({ value: 'from-tier-1' })

    // Moved to primary key and deleted from legacy key
    expect(await consolidated.getItem('testKey')).toEqual({ value: 'from-tier-1' })
    expect(await consolidated.getItem('testLegacyKey')).toBeNull()
  })

  it('migrates from legacy database (Tier 2)', async () => {
    const originalIndexedDb = (globalThis as any).indexedDB
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: 'test-legacy-db' }]),
    }
    try {
      const legacyStoreKey = `test-legacy-db#test-store-${accountId}`
      const legacyStore = new MockLocalforage({ name: 'test-legacy-db', storeName: `test-store-${accountId}` })
      await legacyStore.setItem('testLegacyKey', { value: 'from-tier-2-db' })
      mockInstances.set(legacyStoreKey, legacyStore)

      const data = await store.getScopedData()
      expect(data).toEqual({ value: 'from-tier-2-db' })

      // Moved to primary key in consolidated store and removed from legacy store
      const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
      expect(await consolidated.getItem('testKey')).toEqual({ value: 'from-tier-2-db' })
      expect(await legacyStore.getItem('testLegacyKey')).toBeNull()
    } finally {
      if (originalIndexedDb === undefined) {
        delete (globalThis as any).indexedDB
      } else {
        ;(globalThis as any).indexedDB = originalIndexedDb
      }
    }
  })

  it('clears scoped data and legacy key without wiping other keys in storage', async () => {
    const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
    await consolidated.setItem('unrelatedKey', 'important-data')
    await consolidated.setItem('testKey', { value: 'to-be-cleared' })
    await consolidated.setItem('testLegacyKey', { value: 'legacy-to-be-cleared' })

    await store.clear()

    expect(await consolidated.getItem('testKey')).toBeNull()
    expect(await consolidated.getItem('testLegacyKey')).toBeNull()
    expect(await consolidated.getItem('unrelatedKey')).toBe('important-data')
  })
})

