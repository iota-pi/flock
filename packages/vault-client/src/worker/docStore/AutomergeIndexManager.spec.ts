import { AutomergeIndexManager, mergeIndexDocuments } from './AutomergeIndexManager'
import type { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from './AutomergeDocStore'
import type { ItemId } from '@vault/shared'

/** Yields to other tasks, so concurrent operations interleave as they would against IndexedDB */
const storeLatency = () => new Promise(resolve => setTimeout(resolve, 0))

class MockLockManager {
  private activeLocks = new Map<string, Promise<void>>()

  async request(name: string, optionsOrCallback: any, maybeCallback?: any) {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    const signal: AbortSignal | undefined = typeof optionsOrCallback === 'object' ? optionsOrCallback.signal : undefined

    if (signal?.aborted) {
      throw new Error('Lock request aborted')
    }

    while (this.activeLocks.has(name)) {
      await this.activeLocks.get(name)
    }

    let release: () => void
    const lockPromise = new Promise<void>(resolve => {
      release = resolve
    })
    this.activeLocks.set(name, lockPromise)

    try {
      return await callback()
    } finally {
      this.activeLocks.delete(name)
      release!()
    }
  }
}

describe('AutomergeIndexManager', () => {
  const accountId = 'test-account-123'
  let mockStore: {
    data: AutomergeIndexDocument | null
    getIndex: ReturnType<typeof vi.fn>
    saveIndex: ReturnType<typeof vi.fn>
  }
  let indexStore: IndexStore

  beforeEach(() => {
    mockStore = {
      data: null,
      getIndex: vi.fn(async () => {
        return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
      }),
      saveIndex: vi.fn(async (doc: AutomergeIndexDocument) => {
        mockStore.data = JSON.parse(JSON.stringify(doc))
      }),
    }
    indexStore = mockStore as unknown as IndexStore
  })

  it('should initialize empty snapshot if store is empty', async () => {
    const manager = new AutomergeIndexManager({ accountId, indexStore })
    const snapshot = await manager.getIndexSnapshot()

    expect(snapshot).toEqual({
      accountId,
      itemIds: [],
      tombstoneIds: [],
      metadata: {},
      lastManifestSyncTime: 0,
    })
  })

  it('should ensure index document is created', async () => {
    const manager = new AutomergeIndexManager({ accountId, indexStore })
    await manager.ensureIndexDocument()

    expect(mockStore.saveIndex).toHaveBeenCalledTimes(1)
    const snapshot = await manager.getIndexSnapshot()
    expect(snapshot.accountId).toBe(accountId)
  })

  it('should add item IDs and call onIndexUpdated callback', async () => {
    const onIndexUpdated = vi.fn()
    const manager = new AutomergeIndexManager({ accountId, indexStore, onIndexUpdated: onIndexUpdated })

    await manager.addItemIds(['item-1' as ItemId, 'item-2' as ItemId])

    expect(onIndexUpdated).toHaveBeenCalledWith(['item-1', 'item-2'])
    const items = await manager.listItemIds()
    expect(items).toEqual(['item-1', 'item-2'])

    // Adding existing item should not trigger update or duplicate
    onIndexUpdated.mockClear()
    await manager.addItemIds(['item-1' as ItemId])
    expect(onIndexUpdated).not.toHaveBeenCalled()
  })

  it('should remove item IDs', async () => {
    const onIndexUpdated = vi.fn()
    const manager = new AutomergeIndexManager({ accountId, indexStore, onIndexUpdated: onIndexUpdated })

    await manager.addItemIds(['item-1' as ItemId, 'item-2' as ItemId])

    await manager.removeItemIds(['item-1' as ItemId])

    expect(onIndexUpdated).toHaveBeenLastCalledWith(['item-2'])
    const snapshot = await manager.getIndexSnapshot()
    expect(snapshot.itemIds).toEqual(['item-2'])
    expect(snapshot.tombstoneIds).toEqual(['item-1'])
  })

  it('should track tombstone IDs when items are removed and clear them if re-added', async () => {
    const manager = new AutomergeIndexManager({ accountId, indexStore })

    await manager.addItemIds(['item-a' as ItemId, 'item-b' as ItemId])
    await manager.removeItemIds(['item-a' as ItemId])

    expect(await manager.listTombstoneIds()).toEqual(['item-a'])
    expect(await manager.listItemIds()).toEqual(['item-b'])

    // Re-adding item-a should remove it from tombstoneIds
    await manager.addItemIds(['item-a' as ItemId])
    expect(await manager.listTombstoneIds()).toEqual([])
    expect(await manager.listItemIds()).toEqual(['item-b', 'item-a'])
  })

  it('should update metadata and notify listener', async () => {
    const onMetadataUpdated = vi.fn()
    const manager = new AutomergeIndexManager({ accountId, indexStore, onMetadataUpdated: onMetadataUpdated })

    await manager.updateMetadata({ prayerGoal: 10 })
    expect(onMetadataUpdated).toHaveBeenCalledWith({ prayerGoal: 10 })

    await manager.updateMetadata({ name: 'Test' })
    const metadata = await manager.getMetadata()
    expect(metadata).toEqual({ prayerGoal: 10, name: 'Test' })
  })

  it('should correctly serialize concurrent mutations without clobbering', async () => {
    // Make getIndex and saveIndex yield, as an async store would
    mockStore.getIndex = vi.fn(async () => {
      await storeLatency()
      return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
    })
    mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
      await storeLatency()
      mockStore.data = JSON.parse(JSON.stringify(doc))
    })

    const manager = new AutomergeIndexManager({ accountId, indexStore })

    // Launch multiple concurrent operations simultaneously
    await Promise.all([
      manager.addItemIds(['item-1' as ItemId]),
      manager.addItemIds(['item-2' as ItemId]),
      manager.updateMetadata({ prayerGoal: 5 }),
      manager.addItemIds(['item-3' as ItemId]),
      manager.updateLastManifestSyncTime(9999),
    ])

    const snapshot = await manager.getIndexSnapshot()

    // All additions and metadata updates should have survived without any being clobbered
    expect(snapshot.itemIds).toEqual(expect.arrayContaining(['item-1', 'item-2', 'item-3']))
    expect(snapshot.itemIds).toHaveLength(3)
    expect(snapshot.metadata).toEqual({ prayerGoal: 5 })
    expect(snapshot.lastManifestSyncTime).toBe(9999)
  })

  it('should propagate errors to caller and not deadlock the queue for subsequent tasks', async () => {
    const manager = new AutomergeIndexManager({ accountId, indexStore })

    // First successful write
    await manager.addItemIds(['item-1' as ItemId])

    // Make saveIndex reject on the next call
    mockStore.saveIndex.mockRejectedValueOnce(new Error('Storage failure'))

    // The failing write should reject for the caller
    await expect(manager.addItemIds(['item-fail' as ItemId])).rejects.toThrow(
      'Storage failure'
    )

    // Subsequent write should still execute normally and not be blocked
    await manager.addItemIds(['item-2' as ItemId])

    const itemIds = await manager.listItemIds()
    expect(itemIds).toEqual(['item-1', 'item-2'])
  })

  it('should update manifest sync time', async () => {
    const manager = new AutomergeIndexManager({ accountId, indexStore })
    expect(await manager.getLastManifestSyncTime()).toBe(0)

    await manager.updateLastManifestSyncTime(987654)
    expect(await manager.getLastManifestSyncTime()).toBe(987654)
  })

  it('merges a backup index without hiding newer items or reviving deleted ones', async () => {
    const manager = new AutomergeIndexManager({ accountId, indexStore })
    await manager.addItemIds(['local-new' as ItemId, 'deleted-since' as ItemId])
    await manager.removeItemIds(['deleted-since' as ItemId])
    await manager.updateMetadata({ prayerGoal: 5, localOnly: true })
    await manager.updateLastManifestSyncTime(4444)

    await manager.mergeIndex({
      accountId,
      itemIds: ['restored-1' as ItemId, 'deleted-since' as ItemId],
      tombstoneIds: ['deleted-in-backup' as ItemId, 'local-new' as ItemId],
      metadata: { prayerGoal: 100 },
      lastManifestSyncTime: 8888,
    })

    const snapshot = await manager.getIndexSnapshot()
    expect(new Set(snapshot.itemIds)).toEqual(new Set(['local-new', 'restored-1']))
    expect(new Set(snapshot.tombstoneIds)).toEqual(new Set(['deleted-since', 'deleted-in-backup']))
    expect(snapshot.metadata).toEqual({ prayerGoal: 100, localOnly: true })
    expect(snapshot.lastManifestSyncTime).toBe(4444)
  })

  it('serializes getIndexSnapshot and listItemIds behind in-flight writes to prevent torn reads (M-6)', async () => {
    let isWriteInProgress = false
    mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
      isWriteInProgress = true
      await storeLatency()
      mockStore.data = JSON.parse(JSON.stringify(doc))
      isWriteInProgress = false
    })

    const manager = new AutomergeIndexManager({ accountId, indexStore })

    // Start an in-flight write
    const writePromise = manager.addItemIds(['item-concurrent' as ItemId])

    // Concurrently call getIndexSnapshot and listItemIds
    let snapshotWriteInProgress: boolean | undefined
    let listWriteInProgress: boolean | undefined

    const snapshotPromise = (async () => {
      const snap = await manager.getIndexSnapshot()
      snapshotWriteInProgress = isWriteInProgress
      return snap
    })()
    const listPromise = (async () => {
      const items = await manager.listItemIds()
      listWriteInProgress = isWriteInProgress
      return items
    })()

    const [, snapshot, items] = await Promise.all([writePromise, snapshotPromise, listPromise])

    expect(snapshotWriteInProgress).toBe(false)
    expect(listWriteInProgress).toBe(false)
    expect(snapshot.itemIds).toEqual(['item-concurrent'])
    expect(items).toEqual(['item-concurrent'])
  })

  it('reads the stored index once however many indexed items are bound at startup', async () => {
    const itemIds = Array.from({ length: 200 }, (_, i) => `item-${i}` as ItemId)
    mockStore.data = { accountId, itemIds, tombstoneIds: [], metadata: {}, lastManifestSyncTime: 0 }
    const manager = new AutomergeIndexManager({ accountId, indexStore })

    // What the worker does at startup: list the index, then bind (and so re-add) every item in it
    const listed = await manager.listItemIds()
    await Promise.all(listed.map(id => manager.addItemIds([id])))

    expect(mockStore.getIndex).toHaveBeenCalledTimes(1)
    expect(mockStore.saveIndex).not.toHaveBeenCalled()
  })

  it('removes an item tombstoned already without writing', async () => {
    mockStore.data = { accountId, itemIds: [], tombstoneIds: ['gone' as ItemId], metadata: {}, lastManifestSyncTime: 0 }
    const manager = new AutomergeIndexManager({ accountId, indexStore })

    await manager.removeItemIds(['gone' as ItemId])

    expect(mockStore.saveIndex).not.toHaveBeenCalled()
  })

  it('applies operations in the order they were called, even when a write is skipped', async () => {
    mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
      await storeLatency()
      mockStore.data = JSON.parse(JSON.stringify(doc))
    })
    const manager = new AutomergeIndexManager({ accountId, indexStore })
    await manager.addItemIds(['item-1' as ItemId])

    // The add is checked against the copy only once the removal before it has finished
    await Promise.all([
      manager.removeItemIds(['item-1' as ItemId]),
      manager.addItemIds(['item-1' as ItemId]),
    ])

    expect(await manager.listItemIds()).toEqual(['item-1'])
    expect(mockStore.data?.itemIds).toEqual(['item-1'])
  })

  it("keeps failing while the stored index can't be read, rather than reading it as empty", async () => {
    mockStore.data = { accountId, itemIds: ['item-1' as ItemId], tombstoneIds: [], metadata: {}, lastManifestSyncTime: 0 }
    mockStore.getIndex.mockRejectedValueOnce(new Error('unreadable'))
    const manager = new AutomergeIndexManager({ accountId, indexStore })

    await expect(manager.listItemIds()).rejects.toThrow('unreadable')
    expect(await manager.listItemIds()).toEqual(['item-1'])
  })

  it('reads the stored index again after a save fails', async () => {
    const manager = new AutomergeIndexManager({ accountId, indexStore })
    await manager.addItemIds(['item-1' as ItemId])
    mockStore.saveIndex.mockRejectedValueOnce(new Error('Storage failure'))
    await expect(manager.addItemIds(['item-2' as ItemId])).rejects.toThrow('Storage failure')

    mockStore.getIndex.mockClear()
    expect(await manager.listItemIds()).toEqual(['item-1'])
    expect(mockStore.getIndex).toHaveBeenCalledTimes(1)
  })

  describe('Web Locks (H11)', () => {
    let mockLockManager: MockLockManager
    let originalNavigatorLocks: any

    beforeEach(() => {
      mockLockManager = new MockLockManager()

      originalNavigatorLocks = (global.navigator as any)?.locks
      Object.defineProperty(global.navigator, 'locks', {
        value: mockLockManager,
        writable: true,
        configurable: true,
      })
    })

    afterEach(() => {
      Object.defineProperty(global.navigator, 'locks', {
        value: originalNavigatorLocks,
        writable: true,
        configurable: true,
      })
    })

    it('prevents cross-tab item ID loss when two managers write concurrently (H11)', async () => {
      // Make getIndex and saveIndex yield, as IndexedDB would
      mockStore.getIndex = vi.fn(async () => {
        await storeLatency()
        return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
      })
      mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
        await storeLatency()
        mockStore.data = JSON.parse(JSON.stringify(doc))
      })

      // Two independent manager instances representing Tab A and Tab B pointing to the same shared IndexStore
      const managerA = new AutomergeIndexManager({ accountId, indexStore })
      const managerB = new AutomergeIndexManager({ accountId, indexStore })

      // Tab A creates Item X and Tab B creates Item Y concurrently
      await Promise.all([
        managerA.addItemIds(['item-X' as ItemId]),
        managerB.addItemIds(['item-Y' as ItemId]),
      ])

      // Each manager keeps its own copy, so what counts is the stored index
      const snapshot = await new AutomergeIndexManager({ accountId, indexStore }).getIndexSnapshot()

      // Both item IDs must survive in the index; neither is clobbered
      expect(snapshot.itemIds).toContain('item-X')
      expect(snapshot.itemIds).toContain('item-Y')
      expect(snapshot.itemIds).toHaveLength(2)

    })

    it('preserves items during concurrent add and remove across two tabs', async () => {
      mockStore.data = {
        accountId,
        itemIds: ['item-1' as ItemId, 'item-2' as ItemId],
        metadata: {},
        lastManifestSyncTime: 0,
      }

      mockStore.getIndex = vi.fn(async () => {
        await storeLatency()
        return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
      })
      mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
        await storeLatency()
        mockStore.data = JSON.parse(JSON.stringify(doc))
      })

      const managerA = new AutomergeIndexManager({ accountId, indexStore })
      const managerB = new AutomergeIndexManager({ accountId, indexStore })

      // Tab A adds item-3 while Tab B removes item-1
      await Promise.all([
        managerA.addItemIds(['item-3' as ItemId]),
        managerB.removeItemIds(['item-1' as ItemId]),
      ])

      const snapshot = await new AutomergeIndexManager({ accountId, indexStore }).getIndexSnapshot()
      expect(snapshot.itemIds).toEqual(expect.arrayContaining(['item-2', 'item-3']))
      expect(snapshot.itemIds).not.toContain('item-1')
      expect(snapshot.itemIds).toHaveLength(2)

    })

    it('serializes concurrent metadata update and item addition across two tabs', async () => {
      mockStore.data = {
        accountId,
        itemIds: ['item-1' as ItemId],
        metadata: { prayerGoal: 5 },
        lastManifestSyncTime: 0,
      }

      mockStore.getIndex = vi.fn(async () => {
        await storeLatency()
        return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
      })
      mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
        await storeLatency()
        mockStore.data = JSON.parse(JSON.stringify(doc))
      })

      const managerA = new AutomergeIndexManager({ accountId, indexStore })
      const managerB = new AutomergeIndexManager({ accountId, indexStore })

      // Tab A adds item-2 while Tab B updates metadata
      await Promise.all([
        managerA.addItemIds(['item-2' as ItemId]),
        managerB.updateMetadata({ prayerGoal: 10 }),
      ])

      const snapshot = await new AutomergeIndexManager({ accountId, indexStore }).getIndexSnapshot()
      expect(snapshot.itemIds).toEqual(['item-1', 'item-2'])
      expect(snapshot.metadata).toEqual({ prayerGoal: 10 })

    })

    it('handles aborted lock request cleanly and does not deadlock queue', async () => {
      const manager = new AutomergeIndexManager({ accountId, indexStore })

      // Mock request to throw an abort error once
      const abortError = new Error('Index lock request timed out after 10000ms')
      abortError.name = 'AbortError'
      vi.spyOn(mockLockManager, 'request').mockRejectedValueOnce(abortError)

      await expect(manager.addItemIds(['item-aborted' as ItemId])).rejects.toThrow(
        'Index lock request timed out'
      )

      // Subsequent call with working locks should succeed normally
      await manager.addItemIds(['item-success' as ItemId])
      const snapshot = await manager.getIndexSnapshot()
      expect(snapshot.itemIds).toContain('item-success')

    })

    it("reads this session's copy without the cross-tab lock, but writes take it", async () => {
      const lockRequestSpy = vi.spyOn(mockLockManager, 'request')
      const manager = new AutomergeIndexManager({ accountId, indexStore })

      await manager.getIndexSnapshot()
      await manager.listItemIds()
      await manager.listTombstoneIds()
      await manager.getMetadata()
      expect(lockRequestSpy).not.toHaveBeenCalled()

      await manager.addItemIds(['item-1' as ItemId])
      expect(lockRequestSpy).toHaveBeenCalledWith(
        `test-vault-index-lock-${accountId}`,
        expect.objectContaining({ mode: 'exclusive' }),
        expect.any(Function),
      )
    })

    it('never revives an item another engine tombstoned since this copy was read', async () => {
      mockStore.data = { accountId, itemIds: ['item-X' as ItemId], tombstoneIds: [], metadata: {}, lastManifestSyncTime: 0 }
      const managerA = new AutomergeIndexManager({ accountId, indexStore })
      expect(await managerA.listItemIds()).toEqual(['item-X'])

      // A frozen tab that thawed, say, deletes X after A read its copy
      await new AutomergeIndexManager({ accountId, indexStore }).removeItemIds(['item-X' as ItemId])

      // A's copy still has X live, so re-adding it (as binding it does) writes nothing
      mockStore.saveIndex.mockClear()
      await managerA.addItemIds(['item-X' as ItemId])
      expect(mockStore.saveIndex).not.toHaveBeenCalled()

      // A write that does change something starts from the stored index, so X stays deleted
      await managerA.addItemIds(['item-Y' as ItemId])
      expect(mockStore.data?.itemIds).toEqual(['item-Y'])
      expect(mockStore.data?.tombstoneIds).toEqual(['item-X'])
      expect(await managerA.listItemIds()).toEqual(['item-Y'])
      expect(await managerA.listTombstoneIds()).toEqual(['item-X'])
    })
  })
})

describe('mergeIndexDocuments', () => {
  const id = (value: string) => value as ItemId

  it('keeps local items and deletions, and adds what only the incoming copy knows', () => {
    const merged = mergeIndexDocuments(
      { itemIds: [id('a'), id('b')], tombstoneIds: [id('x')], metadata: { sort: 'local', mine: 1 } },
      { itemIds: [id('c'), id('x')], tombstoneIds: [id('a'), id('y')], metadata: { sort: 'incoming' } },
    )

    expect(new Set(merged.itemIds)).toEqual(new Set(['a', 'b', 'c']))
    expect(new Set(merged.tombstoneIds)).toEqual(new Set(['x', 'y']))
    expect(merged.metadata).toEqual({ sort: 'incoming', mine: 1 })
  })

  it('lets deletions from either side win when asked', () => {
    const merged = mergeIndexDocuments(
      { itemIds: [id('a'), id('b')], tombstoneIds: [id('x')] },
      { itemIds: [id('x'), id('c')], tombstoneIds: [id('a')] },
      { tombstonesWin: true },
    )

    expect(new Set(merged.itemIds)).toEqual(new Set(['b', 'c']))
    expect(new Set(merged.tombstoneIds)).toEqual(new Set(['a', 'x']))
  })

  it('keeps local metadata when asked', () => {
    const merged = mergeIndexDocuments(
      { metadata: { sort: 'local' } },
      { metadata: { sort: 'incoming', other: true } },
      { metadata: 'local' },
    )

    expect(merged.metadata).toEqual({ sort: 'local', other: true })
  })

  it('keeps the local manifest sync time', () => {
    const merged = mergeIndexDocuments({ lastManifestSyncTime: 6 }, { lastManifestSyncTime: 9 })

    expect(merged.lastManifestSyncTime).toBe(6)
  })
})
