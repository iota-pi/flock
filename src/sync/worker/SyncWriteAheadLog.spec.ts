import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import type { ItemId } from 'src/shared/schemas/items'

class MockLocalforage {
  store = new Map<string, any>()
  getItem = vi.fn().mockImplementation(async (key: string) => this.store.get(key) ?? null)
  setItem = vi.fn().mockImplementation(async (key: string, value: any) => {
    this.store.set(key, value)
    return value
  })

  removeItem = vi.fn().mockImplementation(async (key: string) => {
    this.store.delete(key)
  })

  clear = vi.fn().mockImplementation(async () => {
    this.store.clear()
  })

  keys = vi.fn().mockImplementation(async () => Array.from(this.store.keys()))
  length = vi.fn().mockImplementation(async () => this.store.size)
  iterate = vi.fn().mockImplementation(async (fn: (val: any, key: string) => void) => {
    for (const [key, val] of this.store.entries()) {
      fn(val, key)
    }
  })
}

const activeStoreMap = new Map<string, MockLocalforage>()
vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((options: { name: string; storeName: string }) => {
      const key = `${options.name}:${options.storeName}`
      if (!activeStoreMap.has(key)) {
        activeStoreMap.set(key, new MockLocalforage())
      }
      return activeStoreMap.get(key)
    }),
  },
}))

describe('SyncWriteAheadLog', () => {
  let wal: SyncWriteAheadLog

  beforeEach(() => {
    vi.clearAllMocks()
    activeStoreMap.clear()
    wal = new SyncWriteAheadLog('test-account')
  })

  it('appends entries and reads them grouped by item', async () => {
    const data1 = new Uint8Array([1, 2, 3])
    const data2 = new Uint8Array([4, 5, 6])

    const id1 = await wal.append('item-1' as ItemId, data1)
    const id2 = await wal.append('item-1' as ItemId, data2)

    expect(typeof id1).toBe('string')
    expect(typeof id2).toBe('string')

    const entries = await wal.readAll()
    expect(entries.size).toBe(1)
    expect(entries.has('item-1' as ItemId)).toBe(true)

    const item1Entries = entries.get('item-1' as ItemId)!
    expect(item1Entries).toHaveLength(2)
    expect(item1Entries[0].id).toBe(id1)
    expect(item1Entries[0].data).toEqual(data1)
    expect(item1Entries[1].id).toBe(id2)
    expect(item1Entries[1].data).toEqual(data2)
  })

  it('interleaves multiple items and orders each by createdAt', async () => {
    const idA1 = await wal.append('item-A' as ItemId, new Uint8Array([1]))
    const idB1 = await wal.append('item-B' as ItemId, new Uint8Array([2]))
    const idA2 = await wal.append('item-A' as ItemId, new Uint8Array([3]))

    const entries = await wal.readAll()
    expect(entries.size).toBe(2)

    const listA = entries.get('item-A' as ItemId)!
    const listB = entries.get('item-B' as ItemId)!

    expect(listA.map(e => e.id)).toEqual([idA1, idA2])
    expect(listB.map(e => e.id)).toEqual([idB1])
  })

  it('removes only specified entry IDs', async () => {
    const id1 = await wal.append('item-1' as ItemId, new Uint8Array([1]))
    const id2 = await wal.append('item-1' as ItemId, new Uint8Array([2]))
    const id3 = await wal.append('item-2' as ItemId, new Uint8Array([3]))

    // Remove id1 and id3
    await wal.remove([id1, id3])

    const entries = await wal.readAll()
    expect(entries.size).toBe(1)
    expect(entries.has('item-1' as ItemId)).toBe(true)

    const list1 = entries.get('item-1' as ItemId)!
    expect(list1).toHaveLength(1)
    expect(list1[0].id).toBe(id2)
  })

  it('clears all entries on clear()', async () => {
    await wal.append('item-1' as ItemId, new Uint8Array([1]))
    await wal.append('item-2' as ItemId, new Uint8Array([2]))

    await wal.clear()

    const entries = await wal.readAll()
    expect(entries.size).toBe(0)
  })

  it('recovers un-flushed entries when re-instantiated with same account (crash recovery simulation)', async () => {
    const id1 = await wal.append('item-crash' as ItemId, new Uint8Array([99, 100]))

    // Simulate crash and fresh start on same account
    const newWalInstance = new SyncWriteAheadLog('test-account')
    const recovered = await newWalInstance.readAll()

    expect(recovered.has('item-crash' as ItemId)).toBe(true)
    const list = recovered.get('item-crash' as ItemId)!
    expect(list[0].id).toBe(id1)
    expect(list[0].data).toEqual(new Uint8Array([99, 100]))
  })
})
