import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BaseLocalForageStore } from './BaseLocalForageStore'
import * as storageManager from '../../../utils/storageManager'

class MockLocalforage {
  private data = new Map<string, any>()
  public _config = { storeName: 'test-store' }

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

  async length(): Promise<number> {
    return this.data.size
  }

  async keys(): Promise<string[]> {
    return Array.from(this.data.keys())
  }

  async iterate<T, U>(iteratee: (value: T, key: string, iterationNumber: number) => U): Promise<U> {
    let i = 0
    for (const [key, value] of this.data.entries()) {
      iteratee(value, key, i++)
    }
    return undefined as unknown as U
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

class TestStore extends BaseLocalForageStore {
  constructor(optionsOrInstance: any) {
    super(optionsOrInstance)
  }

  async get(key: string) {
    return this.getItem(key)
  }

  async set(key: string, value: any) {
    return this.setItem(key, value)
  }

  async remove(key: string) {
    return this.removeItem(key)
  }

  async forEach(cb: (val: any, key: string) => void) {
    return this.iterate(cb)
  }
}

describe('BaseLocalForageStore', () => {
  let store: TestStore
  let runStorageOperationSpy: any

  beforeEach(() => {
    vi.clearAllMocks()
    runStorageOperationSpy = vi.spyOn(storageManager, 'runStorageOperation')
    store = new TestStore({ name: 'test-db', storeName: 'test-store' })
  })

  it('initializes with options and sets storeName', () => {
    expect(store.storeName).toBe('test-store')
  })

  it('initializes with existing LocalForage instance', () => {
    const existing = new MockLocalforage()
    const customStore = new TestStore(existing as any)
    expect(customStore.storeName).toBe('test-store')
  })

  it('reads and writes items through runStorageOperation', async () => {
    await store.set('key1', 'value1')
    expect(runStorageOperationSpy).toHaveBeenCalled()

    const val = await store.get('key1')
    expect(val).toBe('value1')
  })

  it('removes item through runStorageOperation', async () => {
    await store.set('key1', 'value1')
    expect(await store.get('key1')).toBe('value1')

    await store.remove('key1')
    expect(runStorageOperationSpy).toHaveBeenCalled()
    expect(await store.get('key1')).toBeNull()
  })

  it('clears all items through runStorageOperation', async () => {
    await store.set('k1', 'v1')
    await store.set('k2', 'v2')
    expect(await store.length()).toBe(2)

    await store.clear()
    expect(runStorageOperationSpy).toHaveBeenCalled()
    expect(await store.length()).toBe(0)
  })

  it('lists keys and iterates values', async () => {
    await store.set('a', 1)
    await store.set('b', 2)

    const keys = await store.keys()
    expect(keys).toEqual(['a', 'b'])

    const collected: [string, any][] = []
    await store.forEach((val, key) => {
      collected.push([key, val])
    })
    expect(collected).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })

  it('testStorageAvailable returns true when storage writes succeed', async () => {
    const result = await store.testStorageAvailable()
    expect(result).toBe(true)
  })

  it('testStorageAvailable surfaces QuotaExceededError when storage write fails', async () => {
    const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
    vi.spyOn(activeStore, 'setItem').mockRejectedValueOnce(quotaErr)

    await expect(store.testStorageAvailable()).rejects.toThrow('Quota exceeded')
  })
})
