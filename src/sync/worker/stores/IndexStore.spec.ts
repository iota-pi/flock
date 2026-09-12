import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IndexStore } from './IndexStore'
import type { AutomergeIndexDocument } from '../docStore/AutomergeDocStore'

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

describe('IndexStore', () => {
  let store: IndexStore

  beforeEach(() => {
    store = new IndexStore('account-1')
  })

  it('saves and loads index document correctly', async () => {
    const doc = { itemIds: ['item-1', 'item-2'] } as unknown as AutomergeIndexDocument
    await store.saveIndex(doc)
    const loaded = await store.getIndex()
    expect(loaded).toEqual(doc)
  })

  it('clears index document', async () => {
    const doc = { itemIds: ['item-1'] } as unknown as AutomergeIndexDocument
    await store.saveIndex(doc)
    await store.clear()
    const loaded = await store.getIndex()
    expect(loaded).toBeNull()
  })
})
