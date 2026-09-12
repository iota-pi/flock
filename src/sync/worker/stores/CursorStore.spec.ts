import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CursorStore } from './CursorStore'
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

describe('CursorStore', () => {
  let store: CursorStore

  beforeEach(() => {
    store = new CursorStore('account-1')
  })

  it('saves and loads cursors correctly', async () => {
    const cursors: [ItemId, number][] = [
      ['item-1' as ItemId, 100],
      ['item-2' as ItemId, 200],
    ]

    await store.saveCursors(cursors)
    const loaded = await store.loadCursors()
    expect(loaded).toEqual(cursors)
  })

  it('clears cursors', async () => {
    await store.saveCursors([['item-1' as ItemId, 100]])
    await store.clear()
    const loaded = await store.loadCursors()
    expect(loaded).toBeNull()
  })
})
