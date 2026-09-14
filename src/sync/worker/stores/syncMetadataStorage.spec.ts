import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  getSyncMetadataDBName,
  getSyncMetadataStorage,
  clearSyncMetadataInstancesCacheForTesting,
  clearSyncMetadataStorage,
  clearLegacySyncDatabases,
  SYNC_METADATA_STORE_NAME,
  LEGACY_DB_NAMES,
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

const createdInstances: MockLocalforage[] = []

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => {
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
