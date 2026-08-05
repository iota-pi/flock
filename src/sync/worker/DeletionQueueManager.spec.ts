import { DeletionQueueManager } from './DeletionQueueManager'
import * as deletionStore from '../shared/deletionQueueStore'
import { ItemId } from 'src/shared/schemas/items'

// Mock deletion queue store functions
vi.mock('../shared/deletionQueueStore', () => {
  let store: Record<string, any> = {}
  return {
    scheduleDeletion: vi.fn(async (accountId, itemId, gracePeriodMs) => {
      store[`${accountId}:${itemId}`] = {
        accountId,
        itemId,
        scheduledTime: Date.now() + gracePeriodMs,
      }
    }),
    cancelDeletion: vi.fn(async (accountId, itemId) => {
      delete store[`${accountId}:${itemId}`]
    }),
    listScheduledDeletions: vi.fn(async accountId => {
      return Object.values(store).filter(item => item.accountId === accountId)
    }),
    clearScheduledDeletions: vi.fn(async accountId => {
      for (const key of Object.keys(store)) {
        if (store[key].accountId === accountId) {
          delete store[key]
        }
      }
    }),
    _getStore: () => store,
    _clearStore: () => { store = {} }
  }
})

// Mock docStore functions
const mockRemoveAutomergeItem = vi.fn().mockResolvedValue(undefined)
const mockListAutomergeItemIds = vi.fn().mockResolvedValue(['item-1'])
const mockRemoveAutomergeItemIdsFromIndex = vi.fn().mockResolvedValue(undefined)

vi.mock('./docStore', () => ({
  AutomergeDocStore: vi.fn().mockImplementation(() => ({
    removeAutomergeItem: mockRemoveAutomergeItem,
  }))
}))

vi.mock('./docStore/AutomergeIndexManager', () => ({
  AutomergeIndexManager: vi.fn().mockImplementation(() => ({
    listAutomergeItemIds: mockListAutomergeItemIds,
    removeAutomergeItemIdsFromIndex: mockRemoveAutomergeItemIdsFromIndex,
  }))
}))

describe('DeletionQueueManager', () => {
  let manager: DeletionQueueManager
  const accountId = 'test-account'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    ;(deletionStore as any)._clearStore()

    mockListAutomergeItemIds.mockResolvedValue(['item-1'])

    const mockDocStore = {
      removeAutomergeItem: mockRemoveAutomergeItem,
    } as any

    const mockIndexManager = {
      listAutomergeItemIds: mockListAutomergeItemIds,
      removeAutomergeItemIdsFromIndex: mockRemoveAutomergeItemIdsFromIndex,
    } as any

    manager = new DeletionQueueManager({
      accountId,
      docStore: mockDocStore,
      indexManager: mockIndexManager,
    })
  })

  afterEach(() => {
    manager.stopTimer()
    vi.useRealTimers()
  })

  it('schedules deletion on index change for removed items', async () => {
    await manager.handleIndexChange(new Set(['item-1'] as ItemId[]), new Set(['item-1', 'item-2'] as ItemId[]))
    expect(deletionStore.scheduleDeletion).toHaveBeenCalledWith(accountId, 'item-2', 24 * 60 * 60 * 1000)
    expect(deletionStore.cancelDeletion).not.toHaveBeenCalled()
  })

  it('cancels scheduled deletion for reappearing items', async () => {
    // Schedule first
    await manager.handleIndexChange(new Set(['item-1'] as ItemId[]), new Set(['item-1', 'item-2'] as ItemId[]))

    // Now they reappear
    await manager.handleIndexChange(new Set(['item-1', 'item-2'] as ItemId[]), new Set(['item-1'] as ItemId[]))
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
  })

  it('processes queue and deletes expired items', async () => {
    manager.startTimer()

    await manager.handleIndexChange(new Set(['item-1'] as ItemId[]), new Set(['item-1', 'item-2'] as ItemId[]))

    // Advance 23 hours (not expired yet)
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    expect(mockRemoveAutomergeItem).not.toHaveBeenCalled()

    // Advance past 24 hours (expired!)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(mockRemoveAutomergeItem).toHaveBeenCalledWith('item-2')
    expect(mockRemoveAutomergeItemIdsFromIndex).toHaveBeenCalledWith(['item-2'])
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
  })

  it('does not delete item if it has reappeared during check', async () => {
    await manager.handleIndexChange(new Set(['item-1'] as ItemId[]), new Set(['item-1', 'item-2'] as ItemId[]))

    // Reappeared in index
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

    // Advance time past the 24-hour grace period
    await vi.advanceTimersByTimeAsync(25 * 60 * 60 * 1000)

    await manager.processQueue()

    // Should cancel deletion instead of calling removeAutomergeItem
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
    expect(mockRemoveAutomergeItem).not.toHaveBeenCalled()
  })

  it('clears queue', async () => {
    await manager.clearQueue()
    expect(deletionStore.clearScheduledDeletions).toHaveBeenCalledWith(accountId)
  })

  it('cancels specific deletion', async () => {
    await manager.cancelDeletion('item-1' as ItemId)
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-1')
  })
})
