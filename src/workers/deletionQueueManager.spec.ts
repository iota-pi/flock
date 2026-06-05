import { DeletionQueueManager } from './deletionQueueManager'
import * as deletionStore from '../sync/deletionQueueStore'


// Mock deletion queue store functions
vi.mock('../sync/deletionQueueStore', () => {
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

// Mock automergeDocStore functions
const mockRemoveAutomergeItem = vi.fn().mockResolvedValue(undefined)
vi.mock('../sync/automergeDocStore', () => ({
  removeAutomergeItem: (...args: any[]) => mockRemoveAutomergeItem(...args),
}))

describe('DeletionQueueManager', () => {
  let manager: DeletionQueueManager
  let mockGetIndexHandle: any
  const accountId = 'test-account'

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    ;(deletionStore as any)._clearStore()

    mockGetIndexHandle = vi.fn().mockResolvedValue({
      doc: vi.fn().mockReturnValue({ itemIds: ['item-1'] })
    })

    manager = new DeletionQueueManager(() => ({
      accountId,
      getIndexHandle: mockGetIndexHandle,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules deletion on index change for removed items', async () => {
    await manager.handleIndexChange(new Set(['item-1']), new Set(['item-1', 'item-2']))
    expect(deletionStore.scheduleDeletion).toHaveBeenCalledWith(accountId, 'item-2', 24 * 60 * 60 * 1000)
    expect(deletionStore.cancelDeletion).not.toHaveBeenCalled()
  })

  it('cancels scheduled deletion for reappearing items', async () => {
    // Schedule first
    await manager.handleIndexChange(new Set(['item-1']), new Set(['item-1', 'item-2']))

    // Now they reappear
    await manager.handleIndexChange(new Set(['item-1', 'item-2']), new Set(['item-1']))
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
  })

  it('processes queue and deletes expired items', async () => {
    manager.startTimer()

    await manager.handleIndexChange(new Set(['item-1']), new Set(['item-1', 'item-2']))

    // Advance 23 hours (not expired yet)
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    expect(mockRemoveAutomergeItem).not.toHaveBeenCalled()

    // Advance past 24 hours (expired!)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(mockRemoveAutomergeItem).toHaveBeenCalledWith(accountId, 'item-2')
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
  })

  it('does not delete item if it has reappeared during check', async () => {
    await manager.handleIndexChange(new Set(['item-1']), new Set(['item-1', 'item-2']))

    // Reappeared in index document
    mockGetIndexHandle.mockResolvedValue({
      doc: vi.fn().mockReturnValue({ itemIds: ['item-1', 'item-2'] })
    })

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
    await manager.cancelDeletion('item-1')
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-1')
  })
})
