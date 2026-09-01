import { SyncWriteAheadLog, packBatchedMessages, clearWalInstancesCacheForTesting } from './SyncWriteAheadLog'
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
    clearWalInstancesCacheForTesting()
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

  it('clears all entries via static SyncWriteAheadLog.clear(accountId)', async () => {
    await wal.append('item-1' as ItemId, new Uint8Array([1]))
    await wal.append('item-2' as ItemId, new Uint8Array([2]))

    await SyncWriteAheadLog.clear('test-account')

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

  it('prunes oldest entries when WAL exceeds MAX_ENTRIES', async () => {
    // Populate store directly with entries to simulate reaching limit
    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!
    for (let i = 0; i < SyncWriteAheadLog.MAX_ENTRIES; i++) {
      store.store.set(`id-${i}`, {
        id: `id-${i}`,
        itemId: 'item-bulk' as ItemId,
        data: new Uint8Array([i % 256]),
        createdAt: i,
      })
    }

    expect(await store.length()).toBe(SyncWriteAheadLog.MAX_ENTRIES)

    // Appending a new entry should trigger size limit enforcement
    const newId = await wal.append('item-new' as ItemId, new Uint8Array([255]))

    // Total should now be bounded (pruned PRUNE_BATCH_SIZE oldest entries)
    const currentLength = await store.length()
    expect(currentLength).toBeLessThanOrEqual(SyncWriteAheadLog.MAX_ENTRIES)

    // The newly appended item is present
    expect(store.store.has(newId)).toBe(true)

    // Oldest entries (e.g. id-0) should have been pruned
    expect(store.store.has('id-0')).toBe(false)
  })

  it('recovers from QuotaExceededError by emergency pruning and retrying write', async () => {
    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!
    // Add an older entry
    store.store.set('old-entry', {
      id: 'old-entry',
      itemId: 'item-old' as ItemId,
      data: new Uint8Array([1]),
      createdAt: 1,
    })

    let hasThrownQuota = false
    const originalSetItem = store.setItem
    store.setItem = vi.fn().mockImplementation(async (key: string, value: any) => {
      if (!hasThrownQuota) {
        hasThrownQuota = true
        const quotaErr = new Error('QuotaExceededError: The quota has been exceeded')
        quotaErr.name = 'QuotaExceededError'
        throw quotaErr
      }
      return originalSetItem.call(store, key, value)
    })

    const newId = await wal.append('item-retry' as ItemId, new Uint8Array([42]))
    expect(store.store.has(newId)).toBe(true)
    expect(store.store.has('old-entry')).toBe(false)
  })

  it('compacts multiple entries for the same item into 1 batched entry', async () => {
    const data1 = new Uint8Array([10, 20])
    const data2 = new Uint8Array([30, 40, 50])
    const data3 = new Uint8Array([60])

    await wal.append('item-A' as ItemId, data1)
    await wal.append('item-A' as ItemId, data2)
    await wal.append('item-B' as ItemId, data3)

    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!
    expect(await store.length()).toBe(3)

    const reduced = await wal.compact()
    expect(reduced).toBe(1) // 2 entries for item-A became 1 (reduced by 1), item-B stayed 1
    expect(await store.length()).toBe(2)

    const entries = await wal.readAll()
    const itemAEntries = entries.get('item-A' as ItemId)!
    expect(itemAEntries).toHaveLength(1)
    expect(itemAEntries[0].isBatched).toBe(true)

    // Using packBatchedMessages on itemAEntries should preserve the packed stream
    const packed = packBatchedMessages(itemAEntries)
    expect(packed.length).toBe((4 + data1.length) + (4 + data2.length))
  })

  it('prefers compaction over pruning when multiple entries exist per item', async () => {
    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!
    // Create 2000 entries across only 2 items (1000 each)
    for (let i = 0; i < SyncWriteAheadLog.MAX_ENTRIES; i++) {
      const itemId = i % 2 === 0 ? 'item-even' : 'item-odd'
      store.store.set(`id-${i}`, {
        id: `id-${i}`,
        itemId: itemId as ItemId,
        data: new Uint8Array([1, 2]),
        createdAt: i,
      })
    }

    expect(await store.length()).toBe(SyncWriteAheadLog.MAX_ENTRIES)

    // Append 1 new entry -> triggers size limit enforcement
    await wal.append('item-new' as ItemId, new Uint8Array([9]))

    // After compaction, 2000 entries across 2 items collapse to 2 entries + 1 new entry = 3 total!
    const currentLength = await store.length()
    expect(currentLength).toBe(3)

    const entries = await wal.readAll()
    expect(entries.size).toBe(3)
    expect(entries.has('item-even' as ItemId)).toBe(true)
    expect(entries.has('item-odd' as ItemId)).toBe(true)
    expect(entries.has('item-new' as ItemId)).toBe(true)
  })
})
