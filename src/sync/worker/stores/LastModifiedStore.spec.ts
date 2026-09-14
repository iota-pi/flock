import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LastModifiedStore, type ItemSyncTimestamps } from './LastModifiedStore'
import {
  clearSyncMetadataInstancesCacheForTesting,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { ItemId } from 'src/shared/schemas/items'

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

describe('LastModifiedStore', () => {
  let store: LastModifiedStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    instances.clear()
    clearSyncMetadataInstancesCacheForTesting()
    store = new LastModifiedStore(accountId)
  })

  it('saves and loads dual timestamps correctly in consolidated store', async () => {
    const input: [ItemId, ItemSyncTimestamps][] = [
      ['item-1' as ItemId, { localModifiedAt: 2000, lastSnapshotAt: 1000 }],
      ['item-2' as ItemId, { localModifiedAt: 3000 }],
    ]

    await store.saveTimestamps(input)
    const loaded = await store.loadTimestamps()

    expect(loaded).toEqual([
      ['item-1', { localModifiedAt: 2000, lastSnapshotAt: 1000 }],
      ['item-2', { localModifiedAt: 3000, lastSnapshotAt: undefined }],
    ])

    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.LAST_MODIFIED)).toEqual(input)
  })

  it('normalizes legacy number timestamps on read', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.LAST_MODIFIED, [
      ['item-legacy-1', 5000],
      ['item-legacy-2', 9000],
    ])

    const loaded = await store.loadTimestamps()

    expect(loaded).toEqual([
      ['item-legacy-1', { localModifiedAt: 5000, lastSnapshotAt: 5000 }],
      ['item-legacy-2', { localModifiedAt: 9000, lastSnapshotAt: 9000 }],
    ])
  })

  it('supports backward-compatible loadLastModified and saveLastModified', async () => {
    await store.saveLastModified([
      ['item-1' as ItemId, 12345],
      ['item-2' as ItemId, 67890],
    ])

    const loaded = await store.loadLastModified()
    expect(loaded).toEqual([
      ['item-1', 12345],
      ['item-2', 67890],
    ])

    const timestamps = await store.loadTimestamps()
    expect(timestamps).toEqual([
      ['item-1', { localModifiedAt: 12345, lastSnapshotAt: 12345 }],
      ['item-2', { localModifiedAt: 67890, lastSnapshotAt: 67890 }],
    ])
  })

  it('returns null when storage is empty', async () => {
    const timestamps = await store.loadTimestamps()
    expect(timestamps).toBeNull()

    const lastModified = await store.loadLastModified()
    expect(lastModified).toBeNull()
  })

  it('clears storage key without clearing entire consolidated database', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.CURSORS, [['item-1', 10]])

    await store.saveTimestamps([['item-1' as ItemId, { localModifiedAt: 100 }]])
    await store.clear()

    const loaded = await store.loadTimestamps()
    expect(loaded).toBeNull()

    // Cursors should still exist
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual([['item-1', 10]])
  })

  it('migrates in-store legacy key lastModifiedByItemId', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(LEGACY_KEYS.LAST_MODIFIED, [
      ['item-legacy', 4000],
    ])

    const loaded = await store.loadTimestamps()
    expect(loaded).toEqual([
      ['item-legacy', { localModifiedAt: 4000, lastSnapshotAt: 4000 }],
    ])

    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.LAST_MODIFIED)).toEqual([
      ['item-legacy', { localModifiedAt: 4000, lastSnapshotAt: 4000 }],
    ])
    expect(await consolidatedStore?.getItem(LEGACY_KEYS.LAST_MODIFIED)).toBeNull()
  })

  it('migrates legacy database flock-sync-last-modified', async () => {
    const originalIndexedDb = (globalThis as any).indexedDB
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: LEGACY_DB_NAMES.LAST_MODIFIED }]),
    }
    try {
      const legacyStoreKey = `${LEGACY_DB_NAMES.LAST_MODIFIED}#last-modified-${accountId}`
      const legacyStore = new MockLocalforage({ name: LEGACY_DB_NAMES.LAST_MODIFIED, storeName: `last-modified-${accountId}` })
      await legacyStore.setItem(LEGACY_KEYS.LAST_MODIFIED, [
        ['item-from-old-db', 8888],
      ])
      instances.set(legacyStoreKey, legacyStore)

      const loaded = await store.loadTimestamps()
      expect(loaded).toEqual([
        ['item-from-old-db', { localModifiedAt: 8888, lastSnapshotAt: 8888 }],
      ])

      const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
      expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.LAST_MODIFIED)).toEqual([
        ['item-from-old-db', { localModifiedAt: 8888, lastSnapshotAt: 8888 }],
      ])
      expect(await legacyStore.getItem(LEGACY_KEYS.LAST_MODIFIED)).toBeNull()
    } finally {
      if (originalIndexedDb === undefined) {
        delete (globalThis as any).indexedDB
      } else {
        ;(globalThis as any).indexedDB = originalIndexedDb
      }
    }
  })
})
