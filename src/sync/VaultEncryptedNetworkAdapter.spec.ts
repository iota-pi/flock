import type { DocumentId, Message, PeerId } from '@automerge/automerge-repo/slim'

import { VaultEncryptedNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { getSyncBatchStorage, clearInstancesCacheForTesting, resetQuotaExceededStatus } from './VaultPersistence'
import { registerQuotaReporter } from '../workers/quotaReporter'


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

vi.mock('../api/vault/SyncWorkerClient', () => ({
  pollSyncBatchWithToken: (...args: any[]) => mockPollSyncBatchWithToken(...args),
}))

vi.mock('./workerAuthStore', () => ({
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-auth-token'),
}))

describe('VaultEncryptedNetworkAdapter', () => {
  let adapter: VaultEncryptedNetworkAdapter

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    clearInstancesCacheForTesting()
    resetQuotaExceededStatus()

    // Clear stores for test accounts to avoid state pollution
    const accounts = ['account-queues', 'account-bounds', 'account-chunking', 'account-concurrent', 'account-fails', 'test-account']
    for (const acc of accounts) {
      await getSyncBatchStorage(acc).clear()
    }

    adapter = new VaultEncryptedNetworkAdapter()
    // Keep offline by default to avoid automatic background runs in static tests
    adapter.setOnlineState(false)
    await adapter.setAccount('test-account')
    adapter.setLeader(true)
    adapter.connect('test-peer' as PeerId)
  })

  afterEach(async () => {
    await adapter.disconnect()
    vi.useRealTimers()
  })

  it('queues sync messages to IndexedDB (syncBatchStorage) on send()', async () => {
    const accountId = 'account-queues'
    await adapter.setAccount(accountId)

    const message1: Message = {
      type: 'sync',
      senderId: 'test-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'automerge:item-1' as DocumentId,
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
    await adapter.setAccount(accountId)

    for (let i = 0; i < 2010; i++) {
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: 'automerge:item-1' as any,
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
    await adapter.setAccount(accountId)

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
        documentId: `automerge:item-${i}` as DocumentId,
        data: new Uint8Array([i]),
      })
    }

    // Await persistence timeout by advancing fake timers
    await vi.advanceTimersByTimeAsync(50)

    // Set online and run poll manually and synchronously!
    ;(adapter as any).isOnline = true
    const outcome = await (adapter as any).executePoll()
    expect(outcome).toBe('success')
    ;(adapter as any).isOnline = false

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
    await adapter.setAccount(accountId)

    mockPollSyncBatchWithToken.mockImplementation(async () => {
      // Simulate concurrent local edits added while the poll request is in flight
      // using the real send/append path
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: 'automerge:item-1' as DocumentId,
        data: new Uint8Array([20]),
      })
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: 'automerge:item-1' as DocumentId,
        data: new Uint8Array([30]),
      })
      // Flush them to IndexedDB using the real persistence method
      await (adapter as any).persistPendingWrites()

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
      documentId: 'automerge:item-1' as DocumentId,
      data: new Uint8Array([10]),
    })

    await vi.advanceTimersByTimeAsync(50)

    // Set online and run poll manually and synchronously!
    ;(adapter as any).isOnline = true
    const outcome = await (adapter as any).executePoll()
    expect(outcome).toBe('success')
    ;(adapter as any).isOnline = false

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
    await adapter.setAccount(accountId)

    mockPollSyncBatchWithToken.mockRejectedValue(new Error('Network error'))

    adapter.send({
      type: 'sync',
      senderId: 'test-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'automerge:item-1' as DocumentId,
      data: new Uint8Array([100]),
    })

    await vi.advanceTimersByTimeAsync(50)

    // Set online and run poll manually and synchronously!
    ;(adapter as any).isOnline = true
    const outcome = await (adapter as any).executePoll()
    expect(outcome).toBe('failure')
    ;(adapter as any).isOnline = false

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
      documentId: 'automerge:item-quota-fail' as DocumentId,
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
      documentId: 'automerge:item-quota-fail' as DocumentId,
      data: new Uint8Array([66]),
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(setItemSpy).toHaveBeenCalledTimes(1) // Should still be 1 (didn't call it again)

    setItemSpy.mockRestore()
  })

  it('immediately triggers next poll if hasMore is true', async () => {
    const accountId = 'account-pagination'
    await adapter.setAccount(accountId)

    let pollCount = 0
    mockPollSyncBatchWithToken.mockImplementation(async () => {
      pollCount += 1
      if (pollCount === 1) {
        return {
          success: true,
          pushResults: [],
          pullResults: [
            {
              itemId: 'item-1',
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
              itemId: 'item-1',
              messages: [],
              hasMore: false,
              nextCursor: 20,
            }
          ],
        }
      }
    })

    adapter.setOnlineState(true)
    adapter.queuePendingPullItems(['item-1'])

    // Since the second poll is scheduled with 0ms delay, both polls will execute immediately within 50ms.
    await vi.advanceTimersByTimeAsync(50)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(2)

    // The second poll returned hasMore: false, so the third poll is scheduled for 30 seconds later.
    // Advancing by 1,000ms should not run any new polls.
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(2)

    // Advancing past the 30s backoff delay + jitter should trigger the third poll.
    await vi.advanceTimersByTimeAsync(50000)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(3)
  })
})
