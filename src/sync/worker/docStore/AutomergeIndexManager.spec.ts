import { AutomergeIndexManager } from './AutomergeIndexManager'
import type { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from './AutomergeDocStore'
import type { ItemId } from '../../../shared/schemas/items'

class MockBroadcastChannel {
  name: string
  onmessage: ((ev: MessageEvent) => any) | null = null
  static channels = new Set<MockBroadcastChannel>()

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.channels.add(this)
  }

  postMessage(data: any): void {
    for (const ch of Array.from(MockBroadcastChannel.channels)) {
      if (ch !== this && ch.name === this.name && ch.onmessage) {
        ch.onmessage({ data } as MessageEvent)
      }
    }
  }

  close(): void {
    MockBroadcastChannel.channels.delete(this)
  }
}

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
    const manager = new AutomergeIndexManager(accountId, indexStore)
    const snapshot = await manager.getIndexSnapshot()

    expect(snapshot).toEqual({
      accountId,
      itemIds: [],
      metadata: {},
      lastSyncTime: 0,
      lastManifestSyncTime: 0,
    })
  })

  it('should ensure index document is created', async () => {
    const manager = new AutomergeIndexManager(accountId, indexStore)
    await manager.ensureIndexDocument()

    expect(mockStore.saveIndex).toHaveBeenCalledTimes(1)
    const snapshot = await manager.getIndexSnapshot()
    expect(snapshot.accountId).toBe(accountId)
  })

  it('should add item IDs and call onIndexUpdated callback', async () => {
    const onIndexUpdated = vi.fn()
    const manager = new AutomergeIndexManager(accountId, indexStore, onIndexUpdated)

    await manager.addAutomergeItemIdsToIndex(['item-1' as ItemId, 'item-2' as ItemId])

    expect(onIndexUpdated).toHaveBeenCalledWith(['item-1', 'item-2'])
    const items = await manager.listAutomergeItemIds()
    expect(items).toEqual(['item-1', 'item-2'])

    // Adding existing item should not trigger update or duplicate
    onIndexUpdated.mockClear()
    await manager.addAutomergeItemIdsToIndex(['item-1' as ItemId])
    expect(onIndexUpdated).not.toHaveBeenCalled()
  })

  it('should remove item IDs', async () => {
    const onIndexUpdated = vi.fn()
    const manager = new AutomergeIndexManager(accountId, indexStore, onIndexUpdated)

    await manager.addAutomergeItemIdsToIndex(['item-1' as ItemId, 'item-2' as ItemId])

    await manager.removeAutomergeItemIdsFromIndex(['item-1' as ItemId])

    expect(onIndexUpdated).toHaveBeenLastCalledWith(['item-2'])
    const snapshot = await manager.getIndexSnapshot()
    expect(snapshot.itemIds).toEqual(['item-2'])
  })

  it('should update metadata and notify listener', async () => {
    const onMetadataUpdated = vi.fn()
    const manager = new AutomergeIndexManager(accountId, indexStore, undefined, onMetadataUpdated)

    await manager.updateAutomergeMetadata({ prayerGoal: 10 })
    expect(onMetadataUpdated).toHaveBeenCalledWith({ prayerGoal: 10 })

    await manager.updateAutomergeMetadata({ name: 'Test' })
    const metadata = await manager.getAutomergeMetadata()
    expect(metadata).toEqual({ prayerGoal: 10, name: 'Test' })
  })

  it('should update sync time', async () => {
    const manager = new AutomergeIndexManager(accountId, indexStore)
    expect(await manager.getLastSyncTime()).toBe(0)

    await manager.updateLastSyncTime(123456)
    expect(await manager.getLastSyncTime()).toBe(123456)
  })

  it('should correctly serialize concurrent mutations without clobbering', async () => {
    // Add artificial delay to getIndex and saveIndex to simulate async store delay
    mockStore.getIndex = vi.fn(async () => {
      await new Promise(res => setTimeout(res, 10))
      return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
    })
    mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
      await new Promise(res => setTimeout(res, 10))
      mockStore.data = JSON.parse(JSON.stringify(doc))
    })

    const manager = new AutomergeIndexManager(accountId, indexStore)

    // Launch multiple concurrent operations simultaneously
    await Promise.all([
      manager.addAutomergeItemIdsToIndex(['item-1' as ItemId]),
      manager.addAutomergeItemIdsToIndex(['item-2' as ItemId]),
      manager.updateAutomergeMetadata({ prayerGoal: 5 }),
      manager.addAutomergeItemIdsToIndex(['item-3' as ItemId]),
      manager.updateLastSyncTime(9999),
    ])

    const snapshot = await manager.getIndexSnapshot()

    // All additions and metadata updates should have survived without any being clobbered
    expect(snapshot.itemIds).toEqual(expect.arrayContaining(['item-1', 'item-2', 'item-3']))
    expect(snapshot.itemIds).toHaveLength(3)
    expect(snapshot.metadata).toEqual({ prayerGoal: 5 })
    expect(snapshot.lastSyncTime).toBe(9999)
  })

  it('should propagate errors to caller and not deadlock the queue for subsequent tasks', async () => {
    const manager = new AutomergeIndexManager(accountId, indexStore)

    // First successful write
    await manager.addAutomergeItemIdsToIndex(['item-1' as ItemId])

    // Make saveIndex reject on the next call
    mockStore.saveIndex.mockRejectedValueOnce(new Error('Storage failure'))

    // The failing write should reject for the caller
    await expect(manager.addAutomergeItemIdsToIndex(['item-fail' as ItemId])).rejects.toThrow(
      'Storage failure'
    )

    // Subsequent write should still execute normally and not be blocked
    await manager.addAutomergeItemIdsToIndex(['item-2' as ItemId])

    const itemIds = await manager.listAutomergeItemIds()
    expect(itemIds).toEqual(['item-1', 'item-2'])
  })

  it('should update manifest sync time', async () => {
    const manager = new AutomergeIndexManager(accountId, indexStore)
    expect(await manager.getLastManifestSyncTime()).toBe(0)

    await manager.updateLastManifestSyncTime(987654)
    expect(await manager.getLastManifestSyncTime()).toBe(987654)
  })

  it('should replace the entire index document serialized through queue', async () => {
    const manager = new AutomergeIndexManager(accountId, indexStore)
    const newDoc: AutomergeIndexDocument = {
      accountId,
      itemIds: ['restored-1' as ItemId, 'restored-2' as ItemId],
      metadata: { prayerGoal: 100 },
      lastSyncTime: 7777,
      lastManifestSyncTime: 8888,
    }

    await manager.replaceIndex(newDoc)

    const snapshot = await manager.getIndexSnapshot()
    expect(snapshot).toEqual(newDoc)
  })

  describe('Cross-Tab Concurrency & Web Locks (H11)', () => {
    let mockLockManager: MockLockManager
    let originalNavigatorLocks: any

    beforeEach(() => {
      MockBroadcastChannel.channels.clear()
      vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
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
      MockBroadcastChannel.channels.clear()
      vi.unstubAllGlobals()
    })

    it('prevents cross-tab item ID loss when two managers write concurrently (H11)', async () => {
      // Introduce artificial delay in getIndex and saveIndex to simulate async IndexedDB latency
      mockStore.getIndex = vi.fn(async () => {
        await new Promise(res => setTimeout(res, 15))
        return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
      })
      mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
        await new Promise(res => setTimeout(res, 15))
        mockStore.data = JSON.parse(JSON.stringify(doc))
      })

      // Two independent manager instances representing Tab A and Tab B pointing to the same shared IndexStore
      const managerA = new AutomergeIndexManager(accountId, indexStore)
      const managerB = new AutomergeIndexManager(accountId, indexStore)

      // Tab A creates Item X and Tab B creates Item Y concurrently
      await Promise.all([
        managerA.addAutomergeItemIdsToIndex(['item-X' as ItemId]),
        managerB.addAutomergeItemIdsToIndex(['item-Y' as ItemId]),
      ])

      const snapshot = await managerA.getIndexSnapshot()

      // Both item IDs must survive in the index; neither is clobbered
      expect(snapshot.itemIds).toContain('item-X')
      expect(snapshot.itemIds).toContain('item-Y')
      expect(snapshot.itemIds).toHaveLength(2)

      managerA.close()
      managerB.close()
    })

    it('preserves items during concurrent add and remove across two tabs', async () => {
      mockStore.data = {
        accountId,
        itemIds: ['item-1' as ItemId, 'item-2' as ItemId],
        metadata: {},
        lastSyncTime: 0,
        lastManifestSyncTime: 0,
      }

      mockStore.getIndex = vi.fn(async () => {
        await new Promise(res => setTimeout(res, 10))
        return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
      })
      mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
        await new Promise(res => setTimeout(res, 10))
        mockStore.data = JSON.parse(JSON.stringify(doc))
      })

      const managerA = new AutomergeIndexManager(accountId, indexStore)
      const managerB = new AutomergeIndexManager(accountId, indexStore)

      // Tab A adds item-3 while Tab B removes item-1
      await Promise.all([
        managerA.addAutomergeItemIdsToIndex(['item-3' as ItemId]),
        managerB.removeAutomergeItemIdsFromIndex(['item-1' as ItemId]),
      ])

      const snapshot = await managerA.getIndexSnapshot()
      expect(snapshot.itemIds).toEqual(expect.arrayContaining(['item-2', 'item-3']))
      expect(snapshot.itemIds).not.toContain('item-1')
      expect(snapshot.itemIds).toHaveLength(2)

      managerA.close()
      managerB.close()
    })

    it('serializes concurrent metadata update and item addition across two tabs', async () => {
      mockStore.data = {
        accountId,
        itemIds: ['item-1' as ItemId],
        metadata: { prayerGoal: 5 },
        lastSyncTime: 0,
        lastManifestSyncTime: 0,
      }

      mockStore.getIndex = vi.fn(async () => {
        await new Promise(res => setTimeout(res, 10))
        return mockStore.data ? JSON.parse(JSON.stringify(mockStore.data)) : null
      })
      mockStore.saveIndex = vi.fn(async (doc: AutomergeIndexDocument) => {
        await new Promise(res => setTimeout(res, 10))
        mockStore.data = JSON.parse(JSON.stringify(doc))
      })

      const managerA = new AutomergeIndexManager(accountId, indexStore)
      const managerB = new AutomergeIndexManager(accountId, indexStore)

      // Tab A adds item-2 while Tab B updates metadata
      await Promise.all([
        managerA.addAutomergeItemIdsToIndex(['item-2' as ItemId]),
        managerB.updateAutomergeMetadata({ prayerGoal: 10 }),
      ])

      const snapshot = await managerA.getIndexSnapshot()
      expect(snapshot.itemIds).toEqual(['item-1', 'item-2'])
      expect(snapshot.metadata).toEqual({ prayerGoal: 10 })

      managerA.close()
      managerB.close()
    })

    it('broadcasts index updates to peer tabs via BroadcastChannel', async () => {
      const onIndexUpdatedB = vi.fn()
      const managerA = new AutomergeIndexManager(accountId, indexStore)
      const managerB = new AutomergeIndexManager(accountId, indexStore, onIndexUpdatedB)

      await managerA.addAutomergeItemIdsToIndex(['item-broadcast-1' as ItemId])

      expect(onIndexUpdatedB).toHaveBeenCalledWith(['item-broadcast-1'])

      managerA.close()
      managerB.close()
    })

    it('broadcasts metadata updates to peer tabs via BroadcastChannel', async () => {
      const onMetadataUpdatedB = vi.fn()
      const managerA = new AutomergeIndexManager(accountId, indexStore)
      const managerB = new AutomergeIndexManager(accountId, indexStore, undefined, onMetadataUpdatedB)

      await managerA.updateAutomergeMetadata({ prayerGoal: 25 })

      expect(onMetadataUpdatedB).toHaveBeenCalledWith({ prayerGoal: 25 })

      managerA.close()
      managerB.close()
    })

    it('handles aborted lock request cleanly and does not deadlock queue', async () => {
      const manager = new AutomergeIndexManager(accountId, indexStore)

      // Mock request to throw an abort error once
      const abortError = new Error('Index lock request timed out after 10000ms')
      abortError.name = 'AbortError'
      vi.spyOn(mockLockManager, 'request').mockRejectedValueOnce(abortError)

      await expect(manager.addAutomergeItemIdsToIndex(['item-aborted' as ItemId])).rejects.toThrow(
        'Index lock request timed out'
      )

      // Subsequent call with working locks should succeed normally
      await manager.addAutomergeItemIdsToIndex(['item-success' as ItemId])
      const snapshot = await manager.getIndexSnapshot()
      expect(snapshot.itemIds).toContain('item-success')

      manager.close()
    })

    it('stops receiving messages after close()', async () => {
      const onIndexUpdatedB = vi.fn()
      const managerA = new AutomergeIndexManager(accountId, indexStore)
      const managerB = new AutomergeIndexManager(accountId, indexStore, onIndexUpdatedB)

      managerB.close()

      await managerA.addAutomergeItemIdsToIndex(['item-after-close' as ItemId])

      expect(onIndexUpdatedB).not.toHaveBeenCalled()

      managerA.close()
    })
  })
})
