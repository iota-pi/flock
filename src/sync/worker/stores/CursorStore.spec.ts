import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CursorStore, normalizeCursors } from './CursorStore'
import {
  clearSyncMetadataInstancesCacheForTesting,
  SYNC_METADATA_KEYS,
  LEGACY_KEYS,
  LEGACY_DB_NAMES,
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

describe('CursorStore', () => {
  let store: CursorStore
  const accountId = 'account-1'

  beforeEach(() => {
    vi.clearAllMocks()
    instances.clear()
    clearSyncMetadataInstancesCacheForTesting()
    store = new CursorStore(accountId)
  })

  it('saves and loads cursors correctly using consolidated key', async () => {
    const state = {
      globalCursor: 200,
      retries: [['item-1' as ItemId, 100]] as [ItemId, number][],
    }

    await store.saveCursors(state)
    const loaded = await store.loadCursors()
    expect(loaded).toEqual(state)

    // Verify key in consolidated store
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual(state)
  })

  it('clears cursors without clearing entire database', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    await consolidatedStore?.setItem(SYNC_METADATA_KEYS.INDEX_DOC, { itemIds: ['other'] })

    await store.saveCursors({ globalCursor: 100 })
    await store.clear()

    const loaded = await store.loadCursors()
    expect(loaded).toBeNull()

    // Index doc should remain intact!
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.INDEX_DOC)).toEqual({ itemIds: ['other'] })
  })

  it('migrates legacy in-store key cursorByItemId to cursors', async () => {
    const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
    const legacyCursors: [ItemId, number][] = [['item-legacy' as ItemId, 50]]
    await consolidatedStore?.setItem(LEGACY_KEYS.CURSORS, legacyCursors)

    const loaded = await store.loadCursors()
    expect(loaded).toEqual({
      globalCursor: 50,
      retries: legacyCursors,
    })

    // Key should now be in new cursors key and removed from legacy
    expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual({
      globalCursor: 50,
      retries: legacyCursors,
    })
    expect(await consolidatedStore?.getItem(LEGACY_KEYS.CURSORS)).toBeNull()
  })

  it('migrates legacy database flock-sync-cursors to consolidated storage', async () => {
    const originalIndexedDb = (globalThis as any).indexedDB
    ;(globalThis as any).indexedDB = {
      databases: vi.fn().mockResolvedValue([{ name: LEGACY_DB_NAMES.CURSORS }]),
    }
    try {
      const legacyStoreKey = `${LEGACY_DB_NAMES.CURSORS}#cursors-${accountId}`
      const legacyStore = new MockLocalforage({ name: LEGACY_DB_NAMES.CURSORS, storeName: `cursors-${accountId}` })
      const legacyCursors: [ItemId, number][] = [['item-from-db' as ItemId, 77]]
      await legacyStore.setItem(LEGACY_KEYS.CURSORS, legacyCursors)
      instances.set(legacyStoreKey, legacyStore)

      const loaded = await store.loadCursors()
      expect(loaded).toEqual({
        globalCursor: 77,
        retries: legacyCursors,
      })

      // Verify saved to new consolidated database and removed from legacy
      const consolidatedStore = instances.get(`flock-sync-metadata-${accountId}#sync-metadata`)
      expect(await consolidatedStore?.getItem(SYNC_METADATA_KEYS.CURSORS)).toEqual({
        globalCursor: 77,
        retries: legacyCursors,
      })
      expect(await legacyStore.getItem(LEGACY_KEYS.CURSORS)).toBeNull()
    } finally {
      if (originalIndexedDb === undefined) {
        delete (globalThis as any).indexedDB
      } else {
        ;(globalThis as any).indexedDB = originalIndexedDb
      }
    }
  })

  it('normalizes cursor entries and ignores negative or non-finite values', () => {
    const raw: [ItemId, number][] = [
      ['item-1' as ItemId, 10],
      ['item-2' as ItemId, 100],
      ['item-3' as ItemId, -5],
      ['item-4' as ItemId, NaN],
      ['item-5' as ItemId, Infinity],
      ['item-6' as ItemId, 50],
    ]
    const normalized = normalizeCursors(raw)
    expect(normalized.globalCursor).toBe(100)
    expect(normalized.retries).toEqual([
      ['item-1', 10],
      ['item-2', 100],
      ['item-6', 50],
    ])
  })

  it('handles tens of thousands of items without stack overflow (no Math.max spread)', async () => {
    const largeCount = 70_000
    const largeArray: [ItemId, number][] = Array.from({ length: largeCount }, (_, i) => [
      `item-${i}` as ItemId,
      i + 1,
    ])

    await store.saveCursors(largeArray)
    const loaded = await store.loadCursors()

    expect(loaded).not.toBeNull()
    expect(loaded?.globalCursor).toBe(largeCount)
    expect(loaded?.retries?.length).toBe(largeCount)
  })
})

