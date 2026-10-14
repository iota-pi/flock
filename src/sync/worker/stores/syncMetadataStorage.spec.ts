import {
  getSyncMetadataDBName,
  getSyncMetadataStorage,
  clearSyncMetadataInstancesCacheForTesting,
  clearSyncMetadataStorage,
  clearLegacySyncDatabases,
  probeDatabaseExists,
  hasLegacyDatabase,
  SYNC_METADATA_STORE_NAME,
  SYNC_METADATA_KEYS,
  getLegacySyncDatabaseNames,
  LEGACY_KEYS,
  ScopedMetadataStore,
  type ScopedMetadataStoreOptions,
} from './syncMetadataStorage'
import localforage from 'localforage'

import {
  MockLocalforage,
  createMockLocalForage,
} from '../__test__/testUtils'

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
      const inst = createMockLocalForage(config)
      createdInstances.push(inst)
      return inst
    }),
  },
}))

vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

const legacyDbNames = getLegacySyncDatabaseNames()!

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

  it('defines expected metadata and legacy keys including manual recovery migration', () => {
    expect(SYNC_METADATA_KEYS.MANUAL_RECOVERY_MIGRATED).toBe('manualRecoveryMigrated')
    expect(LEGACY_KEYS.MANUAL_RECOVERY_MIGRATED).toBe('__migrated_v2')
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
      name: legacyDbNames.cursors,
      storeName: 'cursors-acc-legacy',
    })
    expect(createdConfigs).toContainEqual({
      name: legacyDbNames.indexDoc,
      storeName: 'index-acc-legacy',
    })
    expect(createdConfigs).toContainEqual({
      name: legacyDbNames.lastModified,
      storeName: 'last-modified-acc-legacy',
    })
    expect(createdConfigs).toContainEqual({
      name: legacyDbNames.syncedHeads,
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
      const legacyStore = createMockLocalForage({ name: 'test-legacy-db', storeName: `test-store-${accountId}` })
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

  it('migrates from legacy database when indexedDB.databases() throws (Safari Web Worker)', async () => {
    const originalIndexedDb = (globalThis as any).indexedDB
    const mockDbClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockRejectedValue(new Error('SecurityError in Web Worker')),
      open: vi.fn().mockImplementation((name: string) => {
        const req: any = {
          onsuccess: null,
          onerror: null,
          result: { close: mockDbClose },
        }
        setTimeout(() => {
          if (name === 'test-legacy-db') {
            req.onsuccess?.({ target: { result: req.result } })
          } else {
            req.onerror?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() })
          }
        }, 0)
        return req
      }),
    }
    try {
      const legacyStoreKey = `test-legacy-db#test-store-${accountId}`
      const legacyStore = createMockLocalForage({ name: 'test-legacy-db', storeName: `test-store-${accountId}` })
      await legacyStore.setItem('testLegacyKey', { value: 'from-safari-worker-legacy-db' })
      mockInstances.set(legacyStoreKey, legacyStore)

      const data = await store.getScopedData()
      expect(data).toEqual({ value: 'from-safari-worker-legacy-db' })
      expect(mockDbClose).toHaveBeenCalled()

      const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
      expect(await consolidated.getItem('testKey')).toEqual({ value: 'from-safari-worker-legacy-db' })
      expect(await legacyStore.getItem('testLegacyKey')).toBeNull()
    } finally {
      if (originalIndexedDb === undefined) {
        delete (globalThis as any).indexedDB
      } else {
        ;(globalThis as any).indexedDB = originalIndexedDb
      }
    }
  })

  it('migrates from legacy database when indexedDB.databases is undefined (Firefox)', async () => {
    const originalIndexedDb = (globalThis as any).indexedDB
    const mockDbClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation((name: string) => {
        const req: any = {
          onsuccess: null,
          onerror: null,
          result: { close: mockDbClose },
        }
        setTimeout(() => {
          if (name === 'test-legacy-db') {
            req.onsuccess?.({ target: { result: req.result } })
          } else {
            req.onerror?.({ preventDefault: vi.fn(), stopPropagation: vi.fn() })
          }
        }, 0)
        return req
      }),
    }
    try {
      const legacyStoreKey = `test-legacy-db#test-store-${accountId}`
      const legacyStore = createMockLocalForage({ name: 'test-legacy-db', storeName: `test-store-${accountId}` })
      await legacyStore.setItem('testLegacyKey', { value: 'from-firefox-legacy-db' })
      mockInstances.set(legacyStoreKey, legacyStore)

      const data = await store.getScopedData()
      expect(data).toEqual({ value: 'from-firefox-legacy-db' })
      expect(mockDbClose).toHaveBeenCalled()

      const consolidated = getSyncMetadataStorage(accountId) as unknown as MockLocalforage
      expect(await consolidated.getItem('testKey')).toEqual({ value: 'from-firefox-legacy-db' })
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

describe('hasLegacyDatabase and probeDatabaseExists', () => {
  const originalIndexedDb = (globalThis as any).indexedDB

  afterEach(() => {
    if (originalIndexedDb === undefined) {
      delete (globalThis as any).indexedDB
    } else {
      ;(globalThis as any).indexedDB = originalIndexedDb
    }
  })

  it('returns false when indexedDB is undefined', async () => {
    delete (globalThis as any).indexedDB
    expect(await hasLegacyDatabase('some-db')).toBe(false)
    expect(await probeDatabaseExists('some-db')).toBe(false)
  })

  it('probeDatabaseExists returns false when indexedDB.open is missing', async () => {
    ;(globalThis as any).indexedDB = {}
    expect(await probeDatabaseExists('some-db')).toBe(false)
  })

  it('probeDatabaseExists returns true and closes database when onsuccess fires', async () => {
    const mockClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onsuccess?.({ target: { result: { close: mockClose } } })
        }, 0)
        return req
      }),
    }
    const exists = await probeDatabaseExists('existing-db')
    expect(exists).toBe(true)
    expect(mockClose).toHaveBeenCalledTimes(1)
  })

  it('probeDatabaseExists returns false, aborts transaction, and calls deleteDatabase when oldVersion === 0', async () => {
    const mockAbort = vi.fn()
    const mockDelete = vi.fn()
    ;(globalThis as any).indexedDB = {
      deleteDatabase: mockDelete,
      open: vi.fn().mockImplementation(() => {
        const req: any = {
          transaction: { abort: mockAbort },
        }
        setTimeout(() => {
          req.onupgradeneeded?.({
            oldVersion: 0,
            target: { transaction: { abort: mockAbort } },
          })
        }, 0)
        return req
      }),
    }
    const exists = await probeDatabaseExists('non-existent-db')
    expect(exists).toBe(false)
    expect(mockAbort).toHaveBeenCalled()
    expect(mockDelete).toHaveBeenCalledWith('non-existent-db')
  })

  it('probeDatabaseExists returns true when oldVersion > 0 in onupgradeneeded', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onupgradeneeded?.({ oldVersion: 1, target: {} })
        }, 0)
        return req
      }),
    }
    const exists = await probeDatabaseExists('upgraded-db')
    expect(exists).toBe(true)
  })

  it('probeDatabaseExists returns false on error and prevents default', async () => {
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onerror?.({ preventDefault, stopPropagation })
        }, 0)
        return req
      }),
    }
    const exists = await probeDatabaseExists('failing-db')
    expect(exists).toBe(false)
    expect(preventDefault).toHaveBeenCalled()
  })

  it('probeDatabaseExists returns true onblocked', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        const req: any = {}
        setTimeout(() => {
          req.onblocked?.()
        }, 0)
        return req
      }),
    }
    const exists = await probeDatabaseExists('blocked-db')
    expect(exists).toBe(true)
  })

  it('probeDatabaseExists returns false if indexedDB.open throws synchronously', async () => {
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        throw new Error('Access denied')
      }),
    }
    const exists = await probeDatabaseExists('throwing-db')
    expect(exists).toBe(false)
  })

  it('hasLegacyDatabase uses indexedDB.databases() when available and returns match', async () => {
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: 'found-db' }, { name: 'other-db' }]),
      open: vi.fn(),
    }
    expect(await hasLegacyDatabase('found-db')).toBe(true)
    expect(await hasLegacyDatabase('missing-db')).toBe(false)
    expect((globalThis as any).indexedDB.open).not.toHaveBeenCalled()
  })

  it('hasLegacyDatabase falls back to probeDatabaseExists when indexedDB.databases() rejects', async () => {
    const mockClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockRejectedValue(new Error('Safari WebKit worker restriction')),
      open: vi.fn().mockImplementation((name: string) => {
        const req: any = {}
        setTimeout(() => {
          if (name === 'legacy-target') {
            req.onsuccess?.({ target: { result: { close: mockClose } } })
          } else {
            req.onupgradeneeded?.({ oldVersion: 0, target: { transaction: { abort: vi.fn() } } })
          }
        }, 0)
        return req
      }),
    }
    expect(await hasLegacyDatabase('legacy-target')).toBe(true)
    expect(await hasLegacyDatabase('other-target')).toBe(false)
  })

  it('hasLegacyDatabase falls back to probeDatabaseExists when indexedDB.databases is undefined', async () => {
    const mockClose = vi.fn()
    ;(globalThis as any).indexedDB = {
      open: vi.fn().mockImplementation((name: string) => {
        const req: any = {}
        setTimeout(() => {
          if (name === 'firefox-legacy') {
            req.onsuccess?.({ target: { result: { close: mockClose } } })
          } else {
            req.onerror?.({ preventDefault: vi.fn() })
          }
        }, 0)
        return req
      }),
    }
    expect(await hasLegacyDatabase('firefox-legacy')).toBe(true)
    expect(await hasLegacyDatabase('firefox-missing')).toBe(false)
  })
})

