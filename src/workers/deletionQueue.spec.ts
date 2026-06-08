import { SyncWorker } from './sync.worker'
import * as deletionStore from '../sync/deletionQueueStore'
import type { ItemId } from 'src/shared/schemas/items'


// Mock Automerge WASM
vi.mock('@automerge/automerge/slim', () => ({
  initializeWasm: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
  from: vi.fn(),
}))

vi.mock('@automerge/automerge/automerge.wasm?url', () => ({
  default: 'mock-wasm-url'
}))

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
    // Helper to inspect store in tests
    _getStore: () => store,
    _clearStore: () => { store = {} }
  }
})

// Mock automergeDocStore functions
const mockRemoveAutomergeItem = vi.fn().mockResolvedValue(undefined)
const mockRemoveAutomergeItemIdsFromIndex = vi.fn().mockResolvedValue(undefined)
const mockClearAutomergeDocStore = vi.fn().mockResolvedValue(undefined)
const mockListAutomergeItemIds = vi.fn().mockResolvedValue([])

vi.mock('../sync/docStore', () => ({
  initializeAutomergeDocStore: vi.fn().mockResolvedValue(undefined),
  getAutomergeMetadata: vi.fn().mockResolvedValue({}),
  withAutomergeDocumentChange: vi.fn().mockResolvedValue(true),
  withAutomergeMetadataChange: vi.fn().mockResolvedValue(true),
  removeAutomergeItem: (...args: any[]) => mockRemoveAutomergeItem(...args),
  getAutomergeItem: vi.fn().mockResolvedValue(null),
  removeAutomergeItemIdsFromIndex: (...args: any[]) => mockRemoveAutomergeItemIdsFromIndex(...args),
  addAutomergeItemIdsToIndex: vi.fn().mockResolvedValue(undefined),
  listAutomergeItemIds: (...args: any[]) => mockListAutomergeItemIds(...args),
  clearAutomergeDocStore: (...args: any[]) => mockClearAutomergeDocStore(...args),
  exportAllBinaries: vi.fn().mockResolvedValue({}),
  restoreFromBinaries: vi.fn().mockResolvedValue([]),
  normalizeItemSnapshot: vi.fn(),
}))

vi.mock('../sync/docStore/indexManager', () => ({
  listAutomergeItemIds: (...args: any[]) => mockListAutomergeItemIds(...args),
  addAutomergeItemIdsToIndex: vi.fn().mockResolvedValue(undefined),
  removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
  initializeAutomergeDocStore: vi.fn().mockResolvedValue(undefined),
  clearAutomergeDocStore: vi.fn().mockResolvedValue(undefined),
}))

// Mock other dependencies
vi.mock('../api/vault', () => ({
  initWorkerVault: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../sync/automergeRepo', () => {
  const mockRepo = {
    find: vi.fn().mockResolvedValue({
      on: vi.fn(),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({}),
    }),
  }
  return {
    initAutomergeRepo: vi.fn().mockReturnValue(mockRepo),
    getAutomergeDBName: vi.fn().mockReturnValue('mock-db'),
    getAutomergeRepo: vi.fn().mockReturnValue(mockRepo),
  }
})

vi.mock('../sync/automergeRepoIds', () => ({
  toAutomergeUrlFromItemId: vi.fn().mockReturnValue('automerge:item-1'),
}))

vi.mock('src/sync/VaultEncryptedNetworkAdapter', () => {
  return {
    VaultEncryptedNetworkAdapter: class MockAdapter {
      setOnlineState = vi.fn()
      setAccount = vi.fn()
      setSendEnabled = vi.fn()
      disconnect = vi.fn()
      flush = vi.fn()
      exportCursors = vi.fn().mockReturnValue([])
      importCursors = vi.fn()
      executePoll = vi.fn().mockResolvedValue('success')
      hasPendingPulls = vi.fn().mockReturnValue(false)
      onFlushNeeded?: () => void
    }
  }
})

describe('SyncWorker Deletion Queue Integration', () => {
  let worker: SyncWorker
  let mockOnEvent: any
  const accountId = 'test-account'

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    ;(deletionStore as any)._clearStore()

    mockOnEvent = vi.fn().mockResolvedValue(undefined)

    // Initially have item-1 and item-2
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

    worker = new SyncWorker()

    // Initialize worker
    await worker.initRepo(accountId, 'vault-key', mockOnEvent)

    // Set initial subscribedIds
    ;(worker as any).subscribedIds = new Set(['item-1', 'item-2'] as ItemId[])

    // Change listAutomergeItemIds mock to return only item-1 (item-2 deleted)
    mockListAutomergeItemIds.mockResolvedValue(['item-1'])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules deletion for removed index items instead of deleting immediately', async () => {
    // Trigger handleIndexChange
    const newItemIdsSet = new Set(['item-1'] as ItemId[])
    await (worker as any).deletionQueueManager.handleIndexChange(newItemIdsSet, (worker as any).subscribedIds)

    // Verify scheduleDeletion was called for item-2
    expect(deletionStore.scheduleDeletion).toHaveBeenCalledWith(accountId, 'item-2', 24 * 60 * 60 * 1000)
    expect(mockRemoveAutomergeItem).not.toHaveBeenCalled()
  })

  it('cancels scheduled deletion if item reappears in index', async () => {
    // 1. Remove item-2 (schedules deletion)
    const newItemIdsSet1 = new Set(['item-1'] as ItemId[])
    await (worker as any).deletionQueueManager.handleIndexChange(newItemIdsSet1, (worker as any).subscribedIds)
    expect(deletionStore.scheduleDeletion).toHaveBeenCalledWith(accountId, 'item-2', 24 * 60 * 60 * 1000)

    // 2. Mock list to return item-2 back
    mockListAutomergeItemIds.mockResolvedValue(['item-1', 'item-2'])

    // 3. Trigger again
    const newItemIdsSet2 = new Set(['item-1', 'item-2'] as ItemId[])
    await (worker as any).deletionQueueManager.handleIndexChange(newItemIdsSet2, (worker as any).subscribedIds)

    // Verify cancelDeletion was called
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
  })

  it('deletes item from automerge storage when grace period expires', async () => {
    // 1. Remove item-2 to schedule deletion (uses default 24h grace period)
    const newItemIdsSet = new Set(['item-1'] as ItemId[])
    await (worker as any).deletionQueueManager.handleIndexChange(newItemIdsSet, (worker as any).subscribedIds)
    expect(deletionStore.scheduleDeletion).toHaveBeenCalledWith(accountId, 'item-2', 24 * 60 * 60 * 1000)

    // 2. Run timers by 23 hours (should not delete yet)
    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000)
    expect(mockRemoveAutomergeItem).not.toHaveBeenCalled()

    // 3. Run timers past 24 hours total (expired and check timer runs)
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)

    // Verify physical deletion has occurred
    expect(mockRemoveAutomergeItem).toHaveBeenCalledWith(accountId, 'item-2')
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
  })

  it('clears scheduled deletions when shutdown is called', async () => {
    await worker.shutdown()
    expect(deletionStore.clearScheduledDeletions).toHaveBeenCalledWith(accountId)
    expect(mockClearAutomergeDocStore).toHaveBeenCalledWith(accountId)
  })

  it('clears pending timer and cancels deletions on hardDeleteItems', async () => {
    await worker.hardDeleteItems(['item-2' as ItemId])
    expect(deletionStore.cancelDeletion).toHaveBeenCalledWith(accountId, 'item-2')
    expect(mockRemoveAutomergeItem).toHaveBeenCalledWith(accountId, 'item-2')
  })
})
