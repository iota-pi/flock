import type { DocumentId, Message, PeerId } from '@automerge/automerge-repo/slim'

import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { SyncMessageBroker } from './SyncMessageBroker'
import { getSyncBatchStorage, clearInstancesCacheForTesting, resetQuotaExceededStatus } from '../shared/VaultPersistence'
import { registerQuotaReporter } from '../../utils/storageManager'
import { ItemId } from 'src/shared/schemas/items'
import { SyncOrchestrator } from './SyncOrchestrator'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeDocStore } from './docStore'
import { CursorStore } from './stores/CursorStore'
import { SyncPullQueueManager } from './SyncPullQueueManager'

const mockPollSyncBatchWithToken = vi.fn()

vi.mock('src/api/vault', () => ({
  encryptBytes: vi.fn().mockImplementation(async (bytes: Uint8Array) => {
    return {
      iv: 'mock-iv',
      cipher: 'mock-cipher-' + bytes.length,
      kver: '1',
    }
  }),
  decryptBytes: vi.fn().mockImplementation(async () => {
    return new Uint8Array([1, 2, 3])
  }),
}))

vi.mock('../../api/vault/SyncWorkerClient', () => ({
  pollSyncBatchWithToken: (...args: any[]) => mockPollSyncBatchWithToken(...args),
}))

vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-auth-token'),
}))

describe('VaultNetworkAdapter and SyncMessageBroker', () => {
  let adapter: VaultNetworkAdapter
  let broker: SyncMessageBroker
  let orchestrator: SyncOrchestrator
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub
  let mockDocStore: AutomergeDocStore

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearInstancesCacheForTesting()
    resetQuotaExceededStatus()

    mockDocStore = {
      getIndexSnapshot: vi.fn().mockResolvedValue({ itemIds: [], lastModified: {} }),
      addAutomergeItemIdsToIndex: vi.fn().mockResolvedValue(undefined),
      removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
      updateLocalLastModified: vi.fn().mockResolvedValue(undefined),
      updateLastSyncTime: vi.fn().mockResolvedValue(undefined),
    } as unknown as AutomergeDocStore

    // Clear stores for test accounts to avoid state pollution
    const accounts = [
      'account-queues',
      'account-bounds',
      'account-chunking',
      'account-concurrent',
      'account-fails',
      'test-account',
      'account-pagination',
    ]
    for (const acc of accounts) {
      await getSyncBatchStorage(acc).clear()
    }

    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    adapter = new VaultNetworkAdapter()
    const cursorStore = new CursorStore('test-account')
    const pullQueueManager = new SyncPullQueueManager(cursorStore)
    broker = new SyncMessageBroker(adapter, clientEventHub, internalEventHub, mockDocStore as any, pullQueueManager)
    orchestrator = new SyncOrchestrator(
      'test-account',
      broker,
      clientEventHub,
      internalEventHub
    )

    // Keep offline by default to avoid automatic background runs in static tests
    orchestrator.setOnlineState(false)
    adapter.setAccount('test-account')
    await broker.setAccount('test-account')
    orchestrator.setLeader(true)
    adapter.connect('test-peer' as PeerId)
  })

  afterEach(async () => {
    adapter.disconnect()
    await broker.shutdown()
    await orchestrator.shutdown()
    vi.useRealTimers()
  })

  it('queues sync messages to IndexedDB (syncBatchStorage) on send()', async () => {
    const accountId = 'account-queues'
    adapter.setAccount(accountId)
    await broker.setAccount(accountId)

    const message1: Message = {
      type: 'sync',
      senderId: 'test-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'item-1' as DocumentId,
      data: new Uint8Array([1, 2, 3]),
    }

    adapter.send(message1)

    // Await flush/persistence by advancing fake timers
    await vi.advanceTimersByTimeAsync(50)

    const storage = getSyncBatchStorage(accountId)
    const stored: Uint8Array[] | null = await storage.getItem('item-1')
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(1)

    const rawFirst = stored![0] as any
    const normalized = rawFirst instanceof Uint8Array
      ? rawFirst
      : new Uint8Array(Array.from({ ...rawFirst, length: Object.keys(rawFirst).length }))

    expect(Array.from(normalized)).toEqual([1, 2, 3])
  })

  it('enforces bounds of 2000 messages maximum per item', async () => {
    const accountId = 'account-bounds'
    adapter.setAccount(accountId)
    await broker.setAccount(accountId)

    for (let i = 0; i < 2010; i++) {
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: 'item-1' as DocumentId,
        data: new Uint8Array([i % 256]),
      })
    }

    await vi.advanceTimersByTimeAsync(100)

    const storage = getSyncBatchStorage(accountId)
    const stored: Uint8Array[] | null = await storage.getItem('item-1')
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(2000)

    const rawFirst = stored![0] as any
    const normalizedFirst = rawFirst instanceof Uint8Array
      ? rawFirst
      : new Uint8Array(Array.from({ ...rawFirst, length: Object.keys(rawFirst).length }))

    expect(normalizedFirst[0]).toBe(10) // 2010 - 2000 = 10
  })

  it('chunks push requests to a maximum of 5 items per poll request using lodash chunk', async () => {
    const accountId = 'account-chunking'
    adapter.setAccount(accountId)
    await broker.setAccount(accountId)

    mockPollSyncBatchWithToken.mockResolvedValue({
      success: true,
      pushResults: [],
      pullResults: [],
    })

    // Queue messages for 7 different items while offline to prevent early polls
    for (let i = 1; i <= 7; i++) {
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: `item-${i}` as DocumentId,
        data: new Uint8Array([i]),
      })
    }

    // Await persistence timeout by advancing fake timers
    await vi.advanceTimersByTimeAsync(50)

    // Set online and run poll manually and synchronously!
    broker.setOnlineState(true)
    const outcome = await broker.executePoll()
    expect(outcome).toBe('success')
    broker.setOnlineState(false)

    // It should have chunked 7 items into exactly 2 calls (first with 5 items, second with 2 items)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(2)

    const call1 = mockPollSyncBatchWithToken.mock.calls[0][0]
    const call2 = mockPollSyncBatchWithToken.mock.calls[1][0]
    expect(call1.pushMessages).toHaveLength(5)
    expect(call2.pushMessages).toHaveLength(2)

    // Verify all items were transactionally cleaned from IndexedDB
    const storage = getSyncBatchStorage(accountId)
    for (let i = 1; i <= 7; i++) {
      const stored = await storage.getItem(`item-${i}`)
      expect(stored).toBeNull()
    }
  })

  it('safely slices successfully sent messages and retains concurrent local edits', async () => {
    const accountId = 'account-concurrent'
    adapter.setAccount(accountId)
    await broker.setAccount(accountId)

    mockPollSyncBatchWithToken.mockImplementation(async () => {
      // Simulate concurrent local edits added while the poll request is in flight
      // using the real send/append path
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: 'item-1' as DocumentId,
        data: new Uint8Array([20]),
      })
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: 'item-1' as DocumentId,
        data: new Uint8Array([30]),
      })
      // Flush them to IndexedDB using the real persistence method
      await (broker as any).persistPendingWrites()

      return {
        success: true,
        pushResults: [],
        pullResults: [],
      }
    })

    // 1. Initial message sent and queued while offline
    adapter.send({
      type: 'sync',
      senderId: 'test-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'item-1' as DocumentId,
      data: new Uint8Array([10]),
    })

    await vi.advanceTimersByTimeAsync(50)

    // Set online and run poll manually and synchronously!
    broker.setOnlineState(true)
    const outcome = await broker.executePoll()
    expect(outcome).toBe('success')
    broker.setOnlineState(false)

    // The sent message (length 1) should be transactionally sliced out, leaving only the concurrent ones [20, 30]
    const storage = getSyncBatchStorage(accountId)
    const stored: Uint8Array[] | null = await storage.getItem('item-1')
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(2)

    const raw0 = stored![0] as any
    const raw1 = stored![1] as any

    const normalized0 = raw0 instanceof Uint8Array
      ? raw0
      : new Uint8Array(Array.from({ ...raw0, length: Object.keys(raw0).length }))
    const normalized1 = raw1 instanceof Uint8Array
      ? raw1
      : new Uint8Array(Array.from({ ...raw1, length: Object.keys(raw1).length }))

    expect(Array.from(normalized0)).toEqual([20])
    expect(Array.from(normalized1)).toEqual([30])
  })

  it('retains messages in IndexedDB if the poll call fails', async () => {
    const accountId = 'account-fails'
    adapter.setAccount(accountId)
    await broker.setAccount(accountId)

    mockPollSyncBatchWithToken.mockRejectedValue(new Error('Network error'))

    adapter.send({
      type: 'sync',
      senderId: 'test-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'item-1' as DocumentId,
      data: new Uint8Array([100]),
    })

    await vi.advanceTimersByTimeAsync(50)

    // Set online and run poll manually and synchronously!
    broker.setOnlineState(true)
    const outcome = await broker.executePoll()
    expect(outcome).toBe('failure')
    broker.setOnlineState(false)

    // Message must still exist in IndexedDB due to failure
    const storage = getSyncBatchStorage(accountId)
    const stored: Uint8Array[] | null = await storage.getItem('item-1')
    expect(stored).toBeDefined()
    expect(stored).toHaveLength(1)

    const rawFirst = stored![0] as any
    const normalized = rawFirst instanceof Uint8Array
      ? rawFirst
      : new Uint8Array(Array.from({ ...rawFirst, length: Object.keys(rawFirst).length }))

    expect(Array.from(normalized)).toEqual([100])
  })

  it('detects and reports QuotaExceededError when persisting pending writes', async () => {
    resetQuotaExceededStatus()
    const mockReporter = vi.fn()
    registerQuotaReporter(mockReporter)

    const storage = getSyncBatchStorage('test-account')
    const setItemSpy = vi.spyOn(storage, 'setItem').mockRejectedValue(
      new DOMException('Quota exceeded', 'QuotaExceededError')
    )

    adapter.send({
      type: 'sync',
      senderId: 'test-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'item-quota-fail' as DocumentId,
      data: new Uint8Array([55]),
    })

    await vi.advanceTimersByTimeAsync(50)

    expect(setItemSpy).toHaveBeenCalledTimes(1)
    expect(mockReporter).toHaveBeenCalledTimes(1)
    expect(mockReporter.mock.calls[0][0]).toContain('Storage quota exceeded')

    // Subsequent sends should return early and NOT trigger setItem (avoiding loop/spam)
    adapter.send({
      type: 'sync',
      senderId: 'test-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'item-quota-fail' as DocumentId,
      data: new Uint8Array([66]),
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(setItemSpy).toHaveBeenCalledTimes(1) // Should still be 1 (didn't call it again)

    setItemSpy.mockRestore()
  })

  it('immediately triggers next poll if hasMore is true', async () => {
    const accountId = 'account-pagination'
    adapter.setAccount(accountId)
    await broker.setAccount(accountId)

    orchestrator = new SyncOrchestrator(
      accountId,
      broker,
      clientEventHub,
      internalEventHub
    )

    let pollCount = 0
    mockPollSyncBatchWithToken.mockImplementation(async input => {
      pollCount += 1
      const itemId = input?.pullCursors?.[0]?.itemId || 'item-1'
      if (pollCount === 1) {
        return {
          success: true,
          pushResults: [],
          pullResults: [
            {
              itemId,
              messages: [],
              hasMore: true,
              nextCursor: 10,
            }
          ],
        }
      } else {
        return {
          success: true,
          pushResults: [],
          pullResults: [
            {
              itemId,
              messages: [],
              hasMore: false,
              nextCursor: 20,
            }
          ],
        }
      }
    })

    orchestrator.setOnlineState(true)
    orchestrator.setLeader(true)

    // Since the second poll is scheduled with 0ms delay, both polls will execute immediately within 50ms.
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(2)

    // The second poll returned hasMore: false, so the third poll is scheduled for 30 seconds later.
    // Advancing by 1,000ms should not run any new polls.
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(2)

    // Queuing a new pending pull item immediately flushes and triggers poll #3.
    broker.queuePendingPullItems(['item-2' as ItemId])
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(3)

    // Advancing past the 30s backoff delay + jitter triggers poll #4.
    await vi.advanceTimersByTimeAsync(50000)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(4)
  })
})
