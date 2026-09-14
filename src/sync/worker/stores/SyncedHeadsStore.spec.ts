import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SyncedHeadsStore } from './SyncedHeadsStore'
import {
  clearSyncMetadataInstancesCacheForTesting,
  SYNC_METADATA_KEYS,
  LEGACY_DB_NAMES,
  LEGACY_KEYS,
} from './syncMetadataStorage'
import type { DocumentId } from '@automerge/automerge-repo/slim'

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

describe('SyncedHeadsStore', () => {
  let store: SyncedHeadsStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    instances.clear()
    clearSyncMetadataInstancesCacheForTesting()
    store = new SyncedHeadsStore(accountId)
  })

  it('saves and loads synced heads correctly using consolidated key', async () => {
    const input: [DocumentId, string[]][] = [
      ['doc-1' as DocumentId, ['head-1a', 'head-1b']],
      ['doc-2' as DocumentId, ['head-2a']],
    ]

    await store.saveSyncedHeads(input)
    const loaded = await store.loadSyncedHeads()

    expect(loaded).toEqual([
      ['doc-1', ['head-1a', 'head-1b']],
      ['doc-2', ['head-2a']],
    ])

    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.SYNCED_HEADS)).toEqual(input)
  })

  it('returns null when storage is empty', async () => {
    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()
  })

  it('clears storage key without clearing entire consolidated database', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.CURSORS, [['item-1', 10]])

    await store.saveSyncedHeads([['doc-1' as DocumentId, ['head-1']]])
    await store.clear()

    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()

    // Cursors should still exist
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual([['item-1', 10]])
  })

  it('handles invalid data format gracefully', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.SYNCED_HEADS, 'corrupted-data')
    const loaded = await store.loadSyncedHeads()
    expect(loaded).toBeNull()
  })

  it('migrates in-store legacy key syncedHeadsByDocId', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    const legacyData: [DocumentId, string[]][] = [['doc-legacy' as DocumentId, ['head-old']]]
    await consolidatedStore?.setItem(LEGACY_KEYS.SYNCED_HEADS, legacyData)

    const loaded = await store.loadSyncedHeads()
    expect(loaded).toEqual(legacyData)

    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.SYNCED_HEADS)).toEqual(legacyData)
    expect(await consolidatedStore?.getItem(LEGACY_KEYS.SYNCED_HEADS)).toBeNull()
  })

  it('migrates legacy database flock-sync-synced-heads', async () => {
    const originalIndexedDb = (globalThis as any).indexedDB
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: LEGACY_DB_NAMES.SYNCED_HEADS }]),
    }
    try {
      const legacyStoreKey = `${LEGACY_DB_NAMES.SYNCED_HEADS}#synced-heads-${accountId}`
      const legacyStore = new MockLocalforage({ name: LEGACY_DB_NAMES.SYNCED_HEADS, storeName: `synced-heads-${accountId}` })
      const legacyData: [DocumentId, string[]][] = [['doc-from-old-db' as DocumentId, ['head-db']]]
      await legacyStore.setItem(LEGACY_KEYS.SYNCED_HEADS, legacyData)
      instances.set(legacyStoreKey, legacyStore)

      const loaded = await store.loadSyncedHeads()
      expect(loaded).toEqual(legacyData)

      const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
      expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.SYNCED_HEADS)).toEqual(legacyData)
      expect(await legacyStore.getItem(LEGACY_KEYS.SYNCED_HEADS)).toBeNull()
    } finally {
      if (originalIndexedDb === undefined) {
        delete (globalThis as any).indexedDB
      } else {
        ;(globalThis as any).indexedDB = originalIndexedDb
      }
    }
  })
})
