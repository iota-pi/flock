import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AutomergeIndexManager } from './AutomergeIndexManager'
import type { IndexStore } from '../stores/IndexStore'
import type { AutomergeIndexDocument } from './AutomergeDocStore'
import type { ItemId } from '../../../shared/schemas/items'

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
      lastModified: {},
      lastSyncTime: 0,
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

  it('should remove item IDs and clear lastModified timestamps', async () => {
    const onIndexUpdated = vi.fn()
    const manager = new AutomergeIndexManager(accountId, indexStore, onIndexUpdated)

    await manager.addAutomergeItemIdsToIndex(['item-1' as ItemId, 'item-2' as ItemId])
    await manager.updateLocalLastModified({
      ['item-1' as ItemId]: 1000,
      ['item-2' as ItemId]: 2000,
    })

    await manager.removeAutomergeItemIdsFromIndex(['item-1' as ItemId])

    expect(onIndexUpdated).toHaveBeenLastCalledWith(['item-2'])
    const snapshot = await manager.getIndexSnapshot()
    expect(snapshot.itemIds).toEqual(['item-2'])
    expect(snapshot.lastModified).toEqual({ ['item-2']: 2000 })
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
})
