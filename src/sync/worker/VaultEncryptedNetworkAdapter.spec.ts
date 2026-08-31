import { type DocumentId, type Message, type PeerId, Repo } from '@automerge/automerge-repo/slim'
import { decodeSyncMessage, encodeSyncMessage } from '@automerge/automerge/slim'

import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { SyncMessageBroker } from './SyncMessageBroker'
import {
  clearInstancesCacheForTesting,
  resetQuotaExceededStatus,
} from '../shared/VaultPersistence'
import { registerQuotaReporter } from '../../utils/storageManager'
import { SyncOrchestrator } from './SyncOrchestrator'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeDocStore } from './docStore'
import { CursorStore } from './stores/CursorStore'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import type { ItemId } from 'src/shared/schemas/items'

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
      getIndexSnapshot: vi.fn().mockResolvedValue({ itemIds: [] }),
      addAutomergeItemIdsToIndex: vi.fn().mockResolvedValue(undefined),
      removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
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
      await new SyncWriteAheadLog(acc).clear()
    }

    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    adapter = new VaultNetworkAdapter()
    const cursorStore = new CursorStore('test-account')
    const pullQueueManager = new SyncPullQueueManager(cursorStore)
    const wal = new SyncWriteAheadLog('test-account')
    broker = new SyncMessageBroker(adapter, clientEventHub, internalEventHub, mockDocStore as any, pullQueueManager, wal)
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

  it('queues sync messages to SyncWriteAheadLog on send()', async () => {
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

    // Await async append
    await vi.advanceTimersByTimeAsync(50)

    const wal = new SyncWriteAheadLog(accountId)
    const batch = await wal.readAll()
    const item1 = batch.get('item-1' as ItemId)
    expect(item1).toBeDefined()
    expect(item1).toHaveLength(1)
    expect(Array.from(item1![0].data)).toEqual([1, 2, 3])
  })

  it('stores all incoming sync messages in SyncWriteAheadLog', async () => {
    const accountId = 'account-bounds'
    adapter.setAccount(accountId)
    await broker.setAccount(accountId)

    for (let i = 0; i < 20; i++) {
      adapter.send({
        type: 'sync',
        senderId: 'test-peer' as PeerId,
        targetId: 'vault' as PeerId,
        documentId: 'item-1' as DocumentId,
        data: new Uint8Array([i % 256]),
      })
    }

    await vi.advanceTimersByTimeAsync(100)

    const wal = new SyncWriteAheadLog(accountId)
    const batch = await wal.readAll()
    const item1 = batch.get('item-1' as ItemId)
    expect(item1).toBeDefined()
    expect(item1).toHaveLength(20)
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

    // Verify all items were transactionally cleaned from WAL
    const wal = new SyncWriteAheadLog(accountId)
    const batch = await wal.readAll()
    expect(batch.size).toBe(0)
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

    // The sent message should be sliced out, leaving only the concurrent ones [20, 30]
    const wal = new SyncWriteAheadLog(accountId)
    const batch = await wal.readAll()
    const item1 = batch.get('item-1' as ItemId)
    expect(item1).toBeDefined()
    expect(item1).toHaveLength(2)

    expect(Array.from(item1![0].data)).toEqual([20])
    expect(Array.from(item1![1].data)).toEqual([30])
  })

  it('retains messages in SyncWriteAheadLog if the poll call fails', async () => {
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

    // Message must still exist in WAL due to failure
    const wal = new SyncWriteAheadLog(accountId)
    const batch = await wal.readAll()
    const item1 = batch.get('item-1' as ItemId)
    expect(item1).toBeDefined()
    expect(item1).toHaveLength(1)

    expect(Array.from(item1![0].data)).toEqual([100])
  })

  it('detects and reports QuotaExceededError when persisting pending writes', async () => {
    resetQuotaExceededStatus()
    const mockReporter = vi.fn()
    registerQuotaReporter(mockReporter)

    const wal = new SyncWriteAheadLog('test-account')
    const setItemSpy = vi.spyOn((wal as any).storage, 'setItem').mockRejectedValue(
      new DOMException('Quota exceeded', 'QuotaExceededError')
    )
    broker.setWal(wal)

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

    setItemSpy.mockRestore()
  })

  it('sends reflected heads ACK to adapter when receiving initial negotiation message with empty changes', async () => {
    const receiveMessageSpy = vi.spyOn(adapter, 'receiveMessage')
    const testHeads = ['0000000000000000000000000000000000000000000000000000000000000000' as any]
    const initialSyncMsg = encodeSyncMessage({
      heads: testHeads,
      need: [],
      have: [],
      changes: [],
    })

    adapter.setSendEnabled(true)
    adapter.setAccount('test')
    adapter.connect('vault' as PeerId)

    adapter.send({
      type: 'sync',
      senderId: 'client' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'automerge:item-test' as DocumentId,
      data: initialSyncMsg,
    })

    await Promise.resolve()

    expect(receiveMessageSpy).toHaveBeenCalledWith(
      'automerge:item-test',
      expect.any(Uint8Array),
    )

    const receivedPayload = receiveMessageSpy.mock.calls[0][1] as Uint8Array
    const decodedAck = decodeSyncMessage(receivedPayload)
    expect(decodedAck.heads).toEqual(testHeads)
    expect(decodedAck.changes).toEqual([])
  })

  it('does not fire reflected ACK microtask after adapter is disconnected', async () => {
    const receiveMessageSpy = vi.spyOn(adapter, 'receiveMessage')
    const emitSpy = vi.spyOn(adapter, 'emit')
    const testHeads = ['0000000000000000000000000000000000000000000000000000000000000000' as any]
    const initialSyncMsg = encodeSyncMessage({
      heads: testHeads,
      need: [],
      have: [],
      changes: [],
    })

    adapter.setSendEnabled(true)
    adapter.setAccount('test')
    adapter.connect('vault' as PeerId)

    adapter.send({
      type: 'sync',
      senderId: 'client' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'automerge:item-test-disconnect' as DocumentId,
      data: initialSyncMsg,
    })

    // Disconnect immediately after send before microtasks run
    adapter.disconnect()

    // Wait for microtasks to resolve
    await Promise.resolve()

    expect(receiveMessageSpy).not.toHaveBeenCalled()
    expect(emitSpy).not.toHaveBeenCalledWith('message', expect.anything())
  })

  it('reflects heads to prevent history dumps and allows future changes through Automerge Repo', async () => {
    const testAdapter = new VaultNetworkAdapter()
    testAdapter.setSendEnabled(true)
    testAdapter.setAccount('test-account')

    const outgoingMessages: Message[] = []
    testAdapter.onMessageToSend = msg => {
      outgoingMessages.push(msg)
    }

    const repo = new Repo({
      network: [testAdapter],
    })

    // Create a document and populate it with initial data before connection settles
    const handle = repo.create<{ count: number; name?: string }>()
    handle.change(doc => {
      doc.count = 1
    })

    // Allow microtasks and timers for Automerge Repo network handshake and negotiation to execute
    await vi.advanceTimersByTimeAsync(500)
    await Promise.resolve() // flush microtasks

    // 1. Initial negotiation should have been intercepted, heads reflected, and NO changes emitted to onMessageToSend
    expect(outgoingMessages.length).toBe(0)

    // 2. Now perform a new mutation
    handle.change(doc => {
      doc.count = 2
      doc.name = 'updated'
    })

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(50)
      if (outgoingMessages.length >= 1) break
    }

    // 3. The new mutation should produce a sync message that passes through onMessageToSend with changes
    expect(outgoingMessages.length).toBeGreaterThanOrEqual(1)
    const lastMsg = outgoingMessages[outgoingMessages.length - 1]
    expect(lastMsg.type).toBe('sync')
    expect(lastMsg.data).toBeInstanceOf(Uint8Array)

    const decoded = decodeSyncMessage(lastMsg.data as Uint8Array)
    expect(decoded.changes.length).toBeGreaterThan(0)

    await repo.shutdown()
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

    // Advancing past the 30s backoff delay + jitter triggers poll #3.
    await vi.advanceTimersByTimeAsync(50000)
    expect(mockPollSyncBatchWithToken).toHaveBeenCalledTimes(3)
  })

  it('cleans up seededDocuments on disconnect and account change', async () => {
    const testAdapter = new VaultNetworkAdapter()
    testAdapter.setSendEnabled(true)
    testAdapter.setAccount('test-account')
    testAdapter.connect('vault' as PeerId)

    const syncMsg = encodeSyncMessage({
      heads: ['0000000000000000000000000000000000000000000000000000000000000000' as any],
      need: [],
      have: [],
      changes: [],
    })

    const receiveSpy = vi.spyOn(testAdapter, 'receiveMessage')

    // First send adds to seededDocuments and reflects ACK
    testAdapter.send({
      type: 'sync',
      senderId: 'client' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'doc-1' as DocumentId,
      data: syncMsg,
    })
    await Promise.resolve()
    expect(receiveSpy).toHaveBeenCalledTimes(1)

    // Second send for same doc does not re-add or re-reflect
    testAdapter.send({
      type: 'sync',
      senderId: 'client' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'doc-1' as DocumentId,
      data: syncMsg,
    })
    await Promise.resolve()
    expect(receiveSpy).toHaveBeenCalledTimes(1)

    // Disconnecting clears seeded documents
    testAdapter.disconnect()

    // Reconnecting and sending again reflects ACK because seededDocuments was cleared
    testAdapter.connect('vault' as PeerId)
    testAdapter.send({
      type: 'sync',
      senderId: 'client' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'doc-1' as DocumentId,
      data: syncMsg,
    })
    await Promise.resolve()
    expect(receiveSpy).toHaveBeenCalledTimes(2)

    // Changing account also clears seeded documents
    testAdapter.setAccount('other-account')
    testAdapter.send({
      type: 'sync',
      senderId: 'client' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: 'doc-1' as DocumentId,
      data: syncMsg,
    })
    await Promise.resolve()
    expect(receiveSpy).toHaveBeenCalledTimes(3)
  })
})

