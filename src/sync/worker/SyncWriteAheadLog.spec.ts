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

  it('handles empty, nullish, or duplicate IDs safely on remove()', async () => {
    const id1 = await wal.append('item-1' as ItemId, new Uint8Array([1]))
    const id2 = await wal.append('item-1' as ItemId, new Uint8Array([2]))

    // Empty array should be no-op
    await wal.remove([])
    expect((await wal.readAll()).get('item-1' as ItemId)).toHaveLength(2)

    // Duplicate IDs should be deduplicated and remove the item
    await wal.remove([id1, id1, '', null as any, undefined as any])
    const remaining = (await wal.readAll()).get('item-1' as ItemId)!
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe(id2)
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

  it('handles crash between writing compacted entry and removing old entries without duplicating operations', async () => {
    const data1 = new Uint8Array([1, 2])
    const data2 = new Uint8Array([3, 4])
    const id1 = await wal.append('item-crash-atomicity' as ItemId, data1)
    const id2 = await wal.append('item-crash-atomicity' as ItemId, data2)

    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!
    expect(await store.length()).toBe(2)

    // Simulate crash after setItem but before remove(oldIds) completes:
    // Mock remove to throw, leaving both compacted and original entries in storage
    vi.spyOn(wal, 'remove').mockImplementationOnce(async () => {
      throw new Error('Simulated crash / process killed during remove()')
    })

    await expect(wal.compact()).rejects.toThrow('Simulated crash')

    // At this point in storage, both the old entries AND the new compacted entry exist!
    expect(await store.length()).toBe(3)
    expect(store.store.has(id1)).toBe(true)
    expect(store.store.has(id2)).toBe(true)

    // A new instance is created on recovery
    const recoveredWal = new SyncWriteAheadLog('test-account')
    const recoveredMap = await recoveredWal.readAll()

    // It should have only 1 entry for the item (the compacted one), not 3!
    const itemEntries = recoveredMap.get('item-crash-atomicity' as ItemId)!
    expect(itemEntries).toBeDefined()
    expect(itemEntries).toHaveLength(1)
    expect(itemEntries[0].isBatched).toBe(true)
    expect(itemEntries[0].id).not.toBe(id1)
    expect(itemEntries[0].id).not.toBe(id2)

    // The superseded old entries should have been purged from storage
    expect(store.store.has(id1)).toBe(false)
    expect(store.store.has(id2)).toBe(false)
    expect(await store.length()).toBe(1)

    // Subsequent readAll calls still return the single compacted entry
    const secondRead = await recoveredWal.readAll()
    expect(secondRead.get('item-crash-atomicity' as ItemId)!).toHaveLength(1)

    // When the compacted entry is removed (e.g. after sync push), storage becomes completely empty
    await recoveredWal.remove([itemEntries[0].id])
    expect(await store.length()).toBe(0)
  })

  it('handles crash recovery across multiple items where some were interrupted', async () => {
    const idA1 = await wal.append('item-A' as ItemId, new Uint8Array([1]))
    const idA2 = await wal.append('item-A' as ItemId, new Uint8Array([2]))
    const idB1 = await wal.append('item-B' as ItemId, new Uint8Array([3]))
    const idB2 = await wal.append('item-B' as ItemId, new Uint8Array([4]))

    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!

    // In storage, inject a state where item-A was fully compacted, but item-B crashed before remove
    store.store.delete(idA1)
    store.store.delete(idA2)
    store.store.set('compacted-A', {
      id: 'compacted-A',
      itemId: 'item-A' as ItemId,
      data: new Uint8Array([1, 2]),
      createdAt: 100,
      isBatched: true,
      replaces: [idA1, idA2],
    })
    // For item-B: both old and new exist
    store.store.set('compacted-B', {
      id: 'compacted-B',
      itemId: 'item-B' as ItemId,
      data: new Uint8Array([3, 4]),
      createdAt: 200,
      isBatched: true,
      replaces: [idB1, idB2],
    })

    const recoveredWal = new SyncWriteAheadLog('test-account')
    const result = await recoveredWal.readAll()

    expect(result.size).toBe(2)
    expect(result.get('item-A' as ItemId)!).toHaveLength(1)
    expect(result.get('item-B' as ItemId)!).toHaveLength(1)

    // idB1 and idB2 are purged from storage
    expect(store.store.has(idB1)).toBe(false)
    expect(store.store.has(idB2)).toBe(false)
    expect(await store.length()).toBe(2) // only compacted-A and compacted-B
  })

  it('recovers from transitive compaction crashes', async () => {
    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!

    // Suppose e1 and e2 were compacted into c1, which crashed before cleanup
    // Then c1 and e3 were compacted into c2, which also crashed before cleanup
    store.store.set('e1', { id: 'e1', itemId: 'item-transitive' as ItemId, data: new Uint8Array([1]), createdAt: 1 })
    store.store.set('e2', { id: 'e2', itemId: 'item-transitive' as ItemId, data: new Uint8Array([2]), createdAt: 2 })
    store.store.set('c1', { id: 'c1', itemId: 'item-transitive' as ItemId, data: new Uint8Array([1, 2]), createdAt: 2, isBatched: true, replaces: ['e1', 'e2'] })
    store.store.set('e3', { id: 'e3', itemId: 'item-transitive' as ItemId, data: new Uint8Array([3]), createdAt: 3 })
    store.store.set('c2', { id: 'c2', itemId: 'item-transitive' as ItemId, data: new Uint8Array([1, 2, 3]), createdAt: 3, isBatched: true, replaces: ['c1', 'e3', 'e1', 'e2'] })

    const recoveredWal = new SyncWriteAheadLog('test-account')
    const result = await recoveredWal.readAll()

    const entries = result.get('item-transitive' as ItemId)!
    expect(entries).toHaveLength(1)
    expect(entries[0].id).toBe('c2')

    // All ancestor and superseded entries are purged
    expect(store.store.has('e1')).toBe(false)
    expect(store.store.has('e2')).toBe(false)
    expect(store.store.has('c1')).toBe(false)
    expect(store.store.has('e3')).toBe(false)
    expect(await store.length()).toBe(1)
  })

  it('serializes concurrent compact() calls to avoid duplicate work', async () => {
    await wal.append('item-concurrent' as ItemId, new Uint8Array([1]))
    await wal.append('item-concurrent' as ItemId, new Uint8Array([2]))

    const p1 = wal.compact()
    const p2 = wal.compact()

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(1)
    expect(r2).toBe(1)

    const entries = await wal.readAll()
    expect(entries.get('item-concurrent' as ItemId)!).toHaveLength(1)
  })

  it('prunes oldest entries while purging superseded crash remnants', async () => {
    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!

    // Injected superseded entry e1 (older) replaced by c1
    store.store.set('e1', { id: 'e1', itemId: 'item-prune' as ItemId, data: new Uint8Array([1]), createdAt: 1 })
    store.store.set('c1', { id: 'c1', itemId: 'item-prune' as ItemId, data: new Uint8Array([1, 2]), createdAt: 10, isBatched: true, replaces: ['e1'] })
    store.store.set('valid-old', { id: 'valid-old', itemId: 'item-other' as ItemId, data: new Uint8Array([5]), createdAt: 2 })

    // Call private pruneOldest directly via (wal as any).pruneOldest(1)
    await (wal as any).pruneOldest(1)

    // e1 was superseded and should be purged
    expect(store.store.has('e1')).toBe(false)
    // valid-old had createdAt 2 which is oldest among valid entries, so it was pruned
    expect(store.store.has('valid-old')).toBe(false)
    // c1 remains
    expect(store.store.has('c1')).toBe(true)
  })

  it('guarantees ordering of entries appended in the same millisecond using seq counter', async () => {
    const fixedNow = 1700000000000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

    const ids: string[] = []
    // Append 10 entries within the identical millisecond
    for (let i = 1; i <= 10; i++) {
      const id = await wal.append('item-same-ms' as ItemId, new Uint8Array([i]))
      ids.push(id)
    }

    const entriesMap = await wal.readAll()
    const entries = entriesMap.get('item-same-ms' as ItemId)!

    expect(entries).toHaveLength(10)
    // Verify each entry has identical createdAt but strictly increasing seq and matches append order
    for (let i = 0; i < 10; i++) {
      expect(entries[i].id).toBe(ids[i])
      expect(entries[i].createdAt).toBe(fixedNow)
      expect(entries[i].data).toEqual(new Uint8Array([i + 1]))
      expect(entries[i].seq).toBeDefined()
    }
    for (let i = 1; i < 10; i++) {
      expect(entries[i].seq!).toBeGreaterThan(entries[i - 1].seq!)
    }

    vi.restoreAllMocks()
  })

  it('preserves seq ordering across compaction', async () => {
    const fixedNow = 1700000000000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

    await wal.append('item-compact-seq' as ItemId, new Uint8Array([1]))
    await wal.append('item-compact-seq' as ItemId, new Uint8Array([2]))

    const reduced = await wal.compact()
    expect(reduced).toBe(1)

    const entriesMap = await wal.readAll()
    const entries = entriesMap.get('item-compact-seq' as ItemId)!
    expect(entries).toHaveLength(1)
    expect(entries[0].isBatched).toBe(true)
    expect(entries[0].seq).toBeGreaterThan(0)

    vi.restoreAllMocks()
  })

  it('handles legacy entries lacking seq gracefully in readAll', async () => {
    const store = activeStoreMap.get('FlockVault_SyncWAL_test-account:wal-entries')!
    store.store.set('legacy-1', { id: 'legacy-1', itemId: 'item-legacy' as ItemId, data: new Uint8Array([1]), createdAt: 100 })
    store.store.set('legacy-2', { id: 'legacy-2', itemId: 'item-legacy' as ItemId, data: new Uint8Array([2]), createdAt: 100 })

    const entriesMap = await wal.readAll()
    const entries = entriesMap.get('item-legacy' as ItemId)!
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(0)
    expect(entries[1].seq).toBe(0)
  })
})

