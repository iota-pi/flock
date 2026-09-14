import { describe, it, expect, beforeEach, vi } from 'vitest'
import localforage from 'localforage'
import {
  createAccountStore,
  getAccountDatabaseName,
  resolveAccountStoreConfig,
  clearAccountStoreInstancesCacheForTesting,
  clearAccountStore,
} from './createAccountStore'

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

const createdConfigs: Record<string, any>[] = []

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((config: Record<string, any>) => {
      createdConfigs.push(config)
      return new MockLocalforage(config)
    }),
  },
}))

vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

describe('createAccountStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createdConfigs.length = 0
    clearAccountStoreInstancesCacheForTesting()
  })

  describe('database name resolution', () => {
    it('resolves expected db names for known store types', () => {
      expect(getAccountDatabaseName('sync-batch-messages', 'acc-1')).toBe('FlockVault_SyncBatchDB_acc-1')
      expect(getAccountDatabaseName('manual-recovery-items', 'acc-1')).toBe('FlockVault_ManualRecoveryDB_acc-1')
      expect(getAccountDatabaseName('manual-recovery-metadata', 'acc-1')).toBe('FlockVault_ManualRecoveryDB_acc-1')
      expect(getAccountDatabaseName('wal-entries', 'acc-1')).toBe('FlockVault_SyncWAL_acc-1')
      expect(getAccountDatabaseName('sync-metadata', 'acc-1')).toBe('flock-sync-metadata-acc-1')
    })

    it('falls back to convention for custom store names', () => {
      expect(getAccountDatabaseName('custom-store', 'acc-1')).toBe('FlockVault_custom-store_acc-1')
    })

    it('allows overriding dbName or name in options', () => {
      const config1 = resolveAccountStoreConfig('wal-entries', 'acc-1', { dbName: 'custom-db-1' })
      expect(config1.name).toBe('custom-db-1')
      expect(config1.storeName).toBe('wal-entries')

      const config2 = resolveAccountStoreConfig('wal-entries', 'acc-1', { name: 'custom-db-2' })
      expect(config2.name).toBe('custom-db-2')
    })
  })

  describe('caching and isolation', () => {
    it('caches and reuses instance for identical accountId and storeName', () => {
      const store1 = createAccountStore('wal-entries', 'acc-1')
      const store2 = createAccountStore('wal-entries', 'acc-1')

      expect(store1).toBe(store2)
      expect(localforage.createInstance).toHaveBeenCalledTimes(1)
      expect(createdConfigs[0]).toEqual({
        name: 'FlockVault_SyncWAL_acc-1',
        storeName: 'wal-entries',
      })
    })

    it('creates distinct instances for different accounts', () => {
      const store1 = createAccountStore('wal-entries', 'acc-1')
      const store2 = createAccountStore('wal-entries', 'acc-2')

      expect(store1).not.toBe(store2)
      expect(localforage.createInstance).toHaveBeenCalledTimes(2)
    })

    it('creates distinct instances for different stores sharing the same database', () => {
      const itemsStore = createAccountStore('manual-recovery-items', 'acc-1')
      const metaStore = createAccountStore('manual-recovery-metadata', 'acc-1')

      expect(itemsStore).not.toBe(metaStore)
      expect(localforage.createInstance).toHaveBeenCalledTimes(2)
      expect(createdConfigs[0]).toEqual({
        name: 'FlockVault_ManualRecoveryDB_acc-1',
        storeName: 'manual-recovery-items',
      })
      expect(createdConfigs[1]).toEqual({
        name: 'FlockVault_ManualRecoveryDB_acc-1',
        storeName: 'manual-recovery-metadata',
      })
    })

    it('clears instance cache when clearAccountStoreInstancesCacheForTesting is called', () => {
      const store1 = createAccountStore('wal-entries', 'acc-1')
      clearAccountStoreInstancesCacheForTesting()
      const store2 = createAccountStore('wal-entries', 'acc-1')

      expect(store1).not.toBe(store2)
      expect(localforage.createInstance).toHaveBeenCalledTimes(2)
    })
  })

  describe('clearAccountStore', () => {
    it('clears data in the account store', async () => {
      const store = createAccountStore('wal-entries', 'acc-1') as unknown as MockLocalforage
      await store.setItem('entry-1', { data: 'test' })
      expect(store.data.size).toBe(1)

      await clearAccountStore('wal-entries', 'acc-1')
      expect(store.data.size).toBe(0)
    })

    it('does nothing when accountId is empty', async () => {
      await clearAccountStore('wal-entries', '')
      expect(localforage.createInstance).not.toHaveBeenCalled()
    })
  })
})
