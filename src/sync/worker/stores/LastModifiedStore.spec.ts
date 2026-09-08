import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LastModifiedStore, type ItemSyncTimestamps } from './LastModifiedStore'
import type { ItemId } from 'src/shared/schemas/items'

class MockLocalforage {
  private data = new Map<string, any>()

  async getItem<T>(key: string): Promise<T | null> {
    return (this.data.get(key) as T) ?? null
  }

  async setItem<T>(key: string, value: T): Promise<T> {
    this.data.set(key, value)
    return value
  }

  async clear(): Promise<void> {
    this.data.clear()
  }
}

let activeStore: MockLocalforage
vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation(() => {
      activeStore = new MockLocalforage()
      return activeStore
    }),
  },
}))

vi.mock('../../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: () => Promise<any>) => op()),
}))

describe('LastModifiedStore', () => {
  let store: LastModifiedStore

  beforeEach(() => {
    store = new LastModifiedStore('account-1')
  })

  it('saves and loads dual timestamps correctly', async () => {
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
  })

  it('normalizes legacy number timestamps on read', async () => {
    // Simulate legacy storage containing [ItemId, number][]
    await activeStore.setItem('lastModifiedByItemId', [
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

    // Verify loadTimestamps also reflects the dual timestamps
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

  it('clears storage', async () => {
    await store.saveTimestamps([['item-1' as ItemId, { localModifiedAt: 100 }]])
    await store.clear()

    const loaded = await store.loadTimestamps()
    expect(loaded).toBeNull()
  })
})
