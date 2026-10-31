import { SyncWriteAheadLog, toUint8Array } from './SyncWriteAheadLog'
import { WorkerInternalEventHub } from './SyncEventHub'
import type { ItemId } from '@vault/shared'
import { registerQuotaRecoveryHandler, clearQuotaRecoveryHandlerForTesting } from '../utils/storageManager'

import {
  MockLocalforage,
  createMockLocalForage,
  mockLocalForage,
} from './__test__/testUtils'
import { clearAccountStoreInstancesCacheForTesting } from '../shared/createAccountStore'

const activeStoreMap = new Map<string, MockLocalforage>()
const createLocalForageInstance = (options: { name: string; storeName: string }) => {
  const key = `${options.name}:${options.storeName}`
  if (!activeStoreMap.has(key)) {
    activeStoreMap.set(key, createMockLocalForage(options))
  }
  return activeStoreMap.get(key)
}

describe('SyncWriteAheadLog', () => {
  let wal: SyncWriteAheadLog
  let eventHub: WorkerInternalEventHub

  beforeEach(() => {
    mockLocalForage(createLocalForageInstance)
    vi.clearAllMocks()
    activeStoreMap.clear()
    clearAccountStoreInstancesCacheForTesting()
    clearQuotaRecoveryHandlerForTesting()
    eventHub = new WorkerInternalEventHub()
    wal = new SyncWriteAheadLog('test-account', eventHub)
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

  it('recovers un-flushed entries when re-instantiated with same account (crash recovery simulation)', async () => {
    const id1 = await wal.append('item-crash' as ItemId, new Uint8Array([99, 100]))

    // Simulate crash and fresh start on same account
    const newWalInstance = new SyncWriteAheadLog('test-account', new WorkerInternalEventHub())
    const recovered = await newWalInstance.readAll()

    expect(recovered.has('item-crash' as ItemId)).toBe(true)
    const list = recovered.get('item-crash' as ItemId)!
    expect(list[0].id).toBe(id1)
    expect(list[0].data).toEqual(new Uint8Array([99, 100]))
  })

  it('prunes oldest entries when WAL exceeds MAX_ENTRIES', async () => {
    // Populate store directly with entries to simulate reaching limit
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!
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

  it('recovers from QuotaExceededError by emergency pruning and retrying write via registered recovery handler', async () => {
    const unregister = registerQuotaRecoveryHandler(async () => {
      return wal.handleQuotaExceeded()
    })
    try {
      const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!
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
    } finally {
      unregister()
    }
  })

  it('prunes the oldest entries on quota errors and returns how many it removed', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!
    for (let i = 0; i < 3; i += 1) {
      store.store.set(`id-${i}`, { id: `id-${i}`, itemId: `item-${i}` as ItemId, data: new Uint8Array([i]), createdAt: i, seq: i })
    }

    const removed = await wal.handleQuotaExceeded()

    expect(removed).toBe(3)
    expect(await store.length()).toBe(0)
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

  it('handles legacy entries lacking seq gracefully in readAll', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!
    store.store.set('legacy-1', { id: 'legacy-1', itemId: 'item-legacy' as ItemId, data: new Uint8Array([1]), createdAt: 100 })
    store.store.set('legacy-2', { id: 'legacy-2', itemId: 'item-legacy' as ItemId, data: new Uint8Array([2]), createdAt: 100 })

    const entriesMap = await wal.readAll()
    const entries = entriesMap.get('item-legacy' as ItemId)!
    expect(entries).toHaveLength(2)
    expect(entries[0].seq).toBe(0)
    expect(entries[1].seq).toBe(0)
  })

  it('serializes concurrent enforceSizeLimit() calls during concurrent appends to prevent over-deleting entries', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

    // Populate store directly with MAX_ENTRIES unique items
    for (let i = 0; i < SyncWriteAheadLog.MAX_ENTRIES; i++) {
      store.store.set(`id-unique-${i}`, {
        id: `id-unique-${i}`,
        itemId: `item-unique-${i}` as ItemId,
        data: new Uint8Array([1]),
        createdAt: i,
        seq: i,
      })
    }

    expect(await store.length()).toBe(SyncWriteAheadLog.MAX_ENTRIES)

    // Spy on performPruneOldest to verify call count and behavior
    const pruneSpy = vi.spyOn(wal as any, 'performPruneOldest')

    // Simulate 5 concurrent handleOutgoingMessage -> wal.append calls
    const appendPromises = [
      wal.append('item-new-1' as ItemId, new Uint8Array([10])),
      wal.append('item-new-2' as ItemId, new Uint8Array([20])),
      wal.append('item-new-3' as ItemId, new Uint8Array([30])),
      wal.append('item-new-4' as ItemId, new Uint8Array([40])),
      wal.append('item-new-5' as ItemId, new Uint8Array([50])),
    ]

    const newIds = await Promise.all(appendPromises)

    // pruneOldest should only be performed ONCE (pruning PRUNE_BATCH_SIZE entries)
    // rather than 5 times (which would have pruned 5 * PRUNE_BATCH_SIZE entries)
    expect(pruneSpy).toHaveBeenCalledTimes(1)

    // All 5 new entries must be present
    for (const newId of newIds) {
      expect(store.store.has(newId)).toBe(true)
    }

    // Expected storage length: MAX_ENTRIES (2000) - PRUNE_BATCH_SIZE (100) + 5 new entries = 1905
    const finalLength = await store.length()
    expect(finalLength).toBe(SyncWriteAheadLog.MAX_ENTRIES - 100 + 5)
  })

  it('serializes concurrent pruneOldest() calls to avoid duplicate deletion', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

    for (let i = 0; i < 50; i++) {
      store.store.set(`id-${i}`, {
        id: `id-${i}`,
        itemId: `item-${i}` as ItemId,
        data: new Uint8Array([i]),
        createdAt: i,
        seq: i,
      })
    }

    expect(await store.length()).toBe(50)

    const pruneSpy = vi.spyOn(wal as any, 'performPruneOldest')

    // Fire 3 concurrent pruneOldest calls
    await Promise.all([
      (wal as any).pruneOldest(10),
      (wal as any).pruneOldest(10),
      (wal as any).pruneOldest(10),
    ])

    // Should only have executed performPruneOldest once for the batch
    expect(pruneSpy).toHaveBeenCalledTimes(1)
    expect(await store.length()).toBe(40)
  })

  it('does not prune in-flight entries during pruneOldest', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

    store.store.set('entry-inflight-1', {
      id: 'entry-inflight-1',
      itemId: 'item-inflight' as ItemId,
      data: new Uint8Array([1]),
      createdAt: 10,
      seq: 1,
    })
    store.store.set('entry-inflight-2', {
      id: 'entry-inflight-2',
      itemId: 'item-inflight' as ItemId,
      data: new Uint8Array([2]),
      createdAt: 20,
      seq: 2,
    })
    store.store.set('entry-idle-1', {
      id: 'entry-idle-1',
      itemId: 'item-idle' as ItemId,
      data: new Uint8Array([3]),
      createdAt: 30,
      seq: 3,
    })

    // Mark the two older entries in-flight
    wal.markInFlight(['entry-inflight-1', 'entry-inflight-2'])

    // Attempt to prune 2 oldest entries
    await (wal as any).pruneOldest(2)

    // In-flight entries must NOT be deleted despite being the oldest
    expect(store.store.has('entry-inflight-1')).toBe(true)
    expect(store.store.has('entry-inflight-2')).toBe(true)

    // The idle entry should have been pruned
    expect(store.store.has('entry-idle-1')).toBe(false)
  })

  it('skips pruning entirely if all available entries are in-flight', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

    store.store.set('e1', {
      id: 'e1',
      itemId: 'item-1' as ItemId,
      data: new Uint8Array([1]),
      createdAt: 10,
      seq: 1,
    })
    store.store.set('e2', {
      id: 'e2',
      itemId: 'item-2' as ItemId,
      data: new Uint8Array([2]),
      createdAt: 20,
      seq: 2,
    })

    wal.markInFlight(['e1', 'e2'])

    await (wal as any).pruneOldest(5)

    // Both entries must remain untouched
    expect(store.store.has('e1')).toBe(true)
    expect(store.store.has('e2')).toBe(true)
  })

  it('calls onEntriesPruned callback with unique affected itemIds when entries are pruned', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

    store.store.set('prune-1', {
      id: 'prune-1',
      itemId: 'item-A' as ItemId,
      data: new Uint8Array([1]),
      createdAt: 10,
      seq: 1,
    })
    store.store.set('prune-2', {
      id: 'prune-2',
      itemId: 'item-A' as ItemId,
      data: new Uint8Array([2]),
      createdAt: 20,
      seq: 2,
    })
    store.store.set('prune-3', {
      id: 'prune-3',
      itemId: 'item-B' as ItemId,
      data: new Uint8Array([3]),
      createdAt: 30,
      seq: 3,
    })

    const onPruned = vi.fn()
    eventHub.subscribe(e => {
      if (e.type === 'walEntriesPruned') onPruned(e.itemIds)
    })

    // Prune oldest 2 entries (both belong to item-A)
    await (wal as any).pruneOldest(2)

    expect(onPruned).toHaveBeenCalledTimes(1)
    expect(onPruned).toHaveBeenCalledWith(['item-A'])
    expect(store.store.has('prune-1')).toBe(false)
    expect(store.store.has('prune-2')).toBe(false)
    expect(store.store.has('prune-3')).toBe(true)
  })

  it('triggers onEntriesPruned when WAL hits MAX_ENTRIES and prunes oldest entries', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

    // Populate store with MAX_ENTRIES unique items
    for (let i = 0; i < SyncWriteAheadLog.MAX_ENTRIES; i++) {
      store.store.set(`id-unique-${i}`, {
        id: `id-unique-${i}`,
        itemId: `item-unique-${i}` as ItemId,
        data: new Uint8Array([1]),
        createdAt: i,
        seq: i,
      })
    }

    const onPruned = vi.fn()
    eventHub.subscribe(e => {
      if (e.type === 'walEntriesPruned') onPruned(e.itemIds)
    })

    // Append 1 new entry -> triggers size limit enforcement which prunes oldest
    await wal.append('item-new' as ItemId, new Uint8Array([99]))

    expect(onPruned).toHaveBeenCalled()
    const prunedArg = onPruned.mock.calls[0][0]
    expect(Array.isArray(prunedArg)).toBe(true)
    expect(prunedArg.length).toBeGreaterThan(0)
    // Oldest items like item-unique-0 should be in the pruned list
    expect(prunedArg).toContain('item-unique-0')
  })

  it('purges all entries for pruned items even if only some were in the initial slice', async () => {
    const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

    store.store.set('prune-1', {
      id: 'prune-1',
      itemId: 'item-A' as ItemId,
      data: new Uint8Array([1]),
      createdAt: 10,
      seq: 1,
    })
    store.store.set('prune-2', {
      id: 'prune-2',
      itemId: 'item-B' as ItemId,
      data: new Uint8Array([2]),
      createdAt: 20,
      seq: 2,
    })
    store.store.set('prune-3', {
      id: 'prune-3',
      itemId: 'item-A' as ItemId,
      data: new Uint8Array([3]),
      createdAt: 30,
      seq: 3,
    })
    store.store.set('prune-4', {
      id: 'prune-4',
      itemId: 'item-C' as ItemId,
      data: new Uint8Array([4]),
      createdAt: 40,
      seq: 4,
    })

    const onPruned = vi.fn()
    eventHub.subscribe(e => {
      if (e.type === 'walEntriesPruned') onPruned(e.itemIds)
    })

    // Prune oldest 1 entry: this is prune-1 (item-A)
    await (wal as any).pruneOldest(1)

    expect(onPruned).toHaveBeenCalledWith(['item-A'])
    // Both prune-1 and prune-3 (belonging to item-A) should be removed
    expect(store.store.has('prune-1')).toBe(false)
    expect(store.store.has('prune-3')).toBe(false)
    // Other items remain untouched
    expect(store.store.has('prune-2')).toBe(true)
    expect(store.store.has('prune-4')).toBe(true)
  })

  describe('H-8: Pruning cascade excludes items with in-flight entries', () => {
    it('excludes items with active in-flight entries from pruning cascade to prevent partial WAL history', async () => {
      const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

      // item-A has 2 entries: a1 (older) and a2 (newer)
      store.store.set('a1', {
        id: 'a1',
        itemId: 'item-A' as ItemId,
        data: new Uint8Array([1]),
        createdAt: 10,
        seq: 1,
      })
      store.store.set('a2', {
        id: 'a2',
        itemId: 'item-A' as ItemId,
        data: new Uint8Array([2]),
        createdAt: 20,
        seq: 2,
      })
      // item-B has 1 entry
      store.store.set('b1', {
        id: 'b1',
        itemId: 'item-B' as ItemId,
        data: new Uint8Array([3]),
        createdAt: 30,
        seq: 3,
      })

      // Simulate a1 being in-flight (active push), while a2 arrived after push started
      wal.markInFlight(['a1'])

      const onPruned = vi.fn()
      eventHub.subscribe(e => {
        if (e.type === 'walEntriesPruned') onPruned(e.itemIds)
      })

      // Request pruning of 1 entry
      await (wal as any).pruneOldest(1)

      // item-A has an active push, so it must NOT be pruned.
      // Both a1 and a2 must survive in storage (no torn/partial state for item-A!)
      expect(store.store.has('a1')).toBe(true)
      expect(store.store.has('a2')).toBe(true)

      // item-B has no in-flight entries, so b1 is pruned instead
      expect(store.store.has('b1')).toBe(false)
      expect(onPruned).toHaveBeenCalledWith(['item-B'])
      expect(onPruned).not.toHaveBeenCalledWith(expect.arrayContaining(['item-A']))
    })

    it('skips pruning items with in-flight entries even when their non-in-flight entries are the oldest in the WAL', async () => {
      const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

      // item-A has an in-flight entry a-inflight, and a non-in-flight entry a-idle that is the oldest entry overall
      store.store.set('a-idle', {
        id: 'a-idle',
        itemId: 'item-A' as ItemId,
        data: new Uint8Array([1]),
        createdAt: 5,
        seq: 1,
      })
      store.store.set('a-inflight', {
        id: 'a-inflight',
        itemId: 'item-A' as ItemId,
        data: new Uint8Array([2]),
        createdAt: 100,
        seq: 2,
      })
      // item-B has a non-in-flight entry
      store.store.set('b-idle', {
        id: 'b-idle',
        itemId: 'item-B' as ItemId,
        data: new Uint8Array([3]),
        createdAt: 50,
        seq: 3,
      })

      wal.markInFlight(['a-inflight'])

      await (wal as any).pruneOldest(1)

      // Despite a-idle being the oldest entry, item-A has an in-flight entry so item-A is protected
      expect(store.store.has('a-idle')).toBe(true)
      expect(store.store.has('a-inflight')).toBe(true)

      // item-B is pruned
      expect(store.store.has('b-idle')).toBe(false)
    })

    it('does not prune anything if all available entries belong to items with in-flight pushes', async () => {
      const store = activeStoreMap.get('test-vault-wal-test-account:wal-entries')!

      store.store.set('a1', {
        id: 'a1',
        itemId: 'item-A' as ItemId,
        data: new Uint8Array([1]),
        createdAt: 10,
        seq: 1,
      })
      store.store.set('a2', {
        id: 'a2',
        itemId: 'item-A' as ItemId,
        data: new Uint8Array([2]),
        createdAt: 20,
        seq: 2,
      })

      // a1 is in-flight, a2 is available, but both belong to item-A
      wal.markInFlight(['a1'])

      await (wal as any).pruneOldest(5)

      // Nothing should be pruned to avoid torn state for item-A
      expect(store.store.has('a1')).toBe(true)
      expect(store.store.has('a2')).toBe(true)
    })
  })

  describe('worker restart seqCounter persistence (L-5)', () => {
    it('initializes seqCounter from existing storage entries to prevent mis-ordering on restart in same millisecond', async () => {
      const fixedNow = 1700000000000
      vi.spyOn(Date, 'now').mockReturnValue(fixedNow)

      // First worker instance writes 3 entries
      const id1 = await wal.append('item-restart' as ItemId, new Uint8Array([1]))
      const id2 = await wal.append('item-restart' as ItemId, new Uint8Array([2]))
      const id3 = await wal.append('item-restart' as ItemId, new Uint8Array([3]))

      // Simulate worker restart by instantiating a fresh SyncWriteAheadLog for the same account
      const restartedWal = new SyncWriteAheadLog('test-account', new WorkerInternalEventHub())

      // Append 4th entry at identical millisecond timestamp
      const id4 = await restartedWal.append('item-restart' as ItemId, new Uint8Array([4]))

      const entriesMap = await restartedWal.readAll()
      const entries = entriesMap.get('item-restart' as ItemId)!

      expect(entries).toHaveLength(4)
      expect(entries.map(e => e.id)).toEqual([id1, id2, id3, id4])

      // Verify sequence counter strictly advanced beyond previous maximum
      expect(entries[0].seq).toBe(1)
      expect(entries[1].seq).toBe(2)
      expect(entries[2].seq).toBe(3)
      expect(entries[3].seq).toBe(4)

      vi.restoreAllMocks()
    })

    it('ensures timestamps never regress even if system clock jumps backwards across restarts', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(2000)
      const id1 = await wal.append('item-skew' as ItemId, new Uint8Array([1]))

      // Worker restart with clock skewed backwards
      vi.spyOn(Date, 'now').mockReturnValue(1900)
      const restartedWal = new SyncWriteAheadLog('test-account', new WorkerInternalEventHub())
      const id2 = await restartedWal.append('item-skew' as ItemId, new Uint8Array([2]))

      const entriesMap = await restartedWal.readAll()
      const entries = entriesMap.get('item-skew' as ItemId)!

      expect(entries).toHaveLength(2)
      expect(entries[0].id).toBe(id1)
      expect(entries[1].id).toBe(id2)
      expect(entries[1].createdAt).toBeGreaterThanOrEqual(entries[0].createdAt)
      expect(entries[1].seq!).toBeGreaterThan(entries[0].seq!)

      vi.restoreAllMocks()
    })
  })

  describe('toUint8Array conversion without intermediate array (L-6)', () => {
    it('returns original Uint8Array directly', () => {
      const original = new Uint8Array([1, 2, 3])
      expect(toUint8Array(original)).toBe(original)
    })

    it('converts ArrayBuffer and ArrayBufferView views directly without intermediate arrays', () => {
      const buffer = new Uint8Array([10, 20, 30]).buffer
      const fromBuf = toUint8Array(buffer)
      expect(fromBuf).toBeInstanceOf(Uint8Array)
      expect(fromBuf).toEqual(new Uint8Array([10, 20, 30]))

      const view = new DataView(buffer)
      const fromView = toUint8Array(view)
      expect(fromView).toBeInstanceOf(Uint8Array)
      expect(fromView).toEqual(new Uint8Array([10, 20, 30]))
    })

    it('converts number[] array using native constructor', () => {
      const arr = [5, 10, 15]
      const result = toUint8Array(arr)
      expect(result).toBeInstanceOf(Uint8Array)
      expect(result).toEqual(new Uint8Array([5, 10, 15]))
    })

    it('converts indexed object with length directly into pre-allocated Uint8Array', () => {
      const objWithLength = { 0: 42, 1: 84, length: 2 }
      const result = toUint8Array(objWithLength)
      expect(result).toBeInstanceOf(Uint8Array)
      expect(result).toEqual(new Uint8Array([42, 84]))
    })

    it('converts indexed object without length property using key count', () => {
      const objWithoutLength = { 0: 100, 1: 200 }
      const result = toUint8Array(objWithoutLength)
      expect(result).toBeInstanceOf(Uint8Array)
      expect(result).toEqual(new Uint8Array([100, 200]))
    })

    it('handles non-numbers, negative length, and empty input gracefully', () => {
      expect(toUint8Array(null)).toEqual(new Uint8Array())
      expect(toUint8Array(undefined)).toEqual(new Uint8Array())
      expect(toUint8Array('not an object')).toEqual(new Uint8Array())
      expect(toUint8Array({ length: -5 })).toEqual(new Uint8Array())
      expect(toUint8Array({ 0: 'invalid', 1: 99, length: 2 })).toEqual(new Uint8Array([0, 99]))
    })
  })
})

