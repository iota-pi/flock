import { interpretAsDocumentId, type PeerId } from '@automerge/automerge-repo/slim'
import * as Automerge from '@automerge/automerge/slim'

import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncPoller } from './SyncPoller'
import { SyncMessageBroker } from './SyncMessageBroker'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { CursorStore } from './stores/CursorStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'

// Mock localforage for isolated in-memory stores per test
class MockLocalForageInstance {
  store = new Map<string, any>()
  getItem = vi.fn().mockImplementation(async (key: string) => this.store.get(key) ?? null)
  setItem = vi.fn().mockImplementation(async (key: string, value: any) => {
    this.store.set(key, value)
    return value
  })
  removeItem = vi.fn().mockImplementation(async (key: string) => {
    this.store.delete(key)
  })
  clear = vi.fn().mockImplementation(async () => {
    this.store.clear()
  })
  keys = vi.fn().mockImplementation(async () => Array.from(this.store.keys()))
  length = vi.fn().mockImplementation(async () => this.store.size)
  iterate = vi.fn().mockImplementation(async (fn: (val: any, key: string) => void) => {
    for (const [key, val] of this.store.entries()) {
      fn(val, key)
    }
  })
}

const mockStores = new Map<string, MockLocalForageInstance>()
vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((opts: { name: string; storeName: string }) => {
      const key = `${opts.name}:${opts.storeName}`
      if (!mockStores.has(key)) {
        mockStores.set(key, new MockLocalForageInstance())
      }
      return mockStores.get(key)
    }),
  },
}))

const mockPollSyncBatchWithToken = vi.fn()
vi.mock('../../api/vault/SyncWorkerClient', () => ({
  pollSyncBatchWithToken: (...args: any[]) => mockPollSyncBatchWithToken(...args),
  putSnapshotsWithToken: vi.fn().mockResolvedValue({ success: true }),
}))

vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-session-token'),
}))

vi.mock('../../api/vault', () => ({
  encryptBytes: vi.fn().mockImplementation(async (bytes: Uint8Array) => ({
    iv: 'mock-iv',
    cipher: 'mock-cipher-' + bytes.length,
    kver: '1',
  })),
  decryptBytes: vi.fn().mockImplementation(async (enc: any) => {
    if (enc.cipher === 'corrupt-cipher') {
      throw new Error('Decryption failure: MAC mismatch')
    }
    return new Uint8Array([1, 2, 3])
  }),
}))

function createTestSyncMessageData(): Uint8Array {
  return Automerge.encodeSyncMessage({
    heads: [],
    need: [],
    have: [],
    changes: [new Uint8Array([1, 2, 3])],
  })
}

describe('Sync System Integration Test Suite', () => {
  const accountId = 'test-integration-account'
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub
  let indexManager: AutomergeIndexManager
  let cursorStore: CursorStore
  let pullQueueManager: SyncPullQueueManager
  let wal: SyncWriteAheadLog
  let adapter: VaultNetworkAdapter
  let broker: SyncMessageBroker

  beforeEach(async () => {
    vi.clearAllMocks()
    mockStores.clear()

    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    cursorStore = new CursorStore(accountId)
    pullQueueManager = new SyncPullQueueManager(cursorStore)
    wal = new SyncWriteAheadLog(accountId)
    adapter = new VaultNetworkAdapter()

    indexManager = {
      updateLastSyncTime: vi.fn().mockResolvedValue(undefined),
      addAutomergeItemIdsToIndex: vi.fn().mockResolvedValue(undefined),
      removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
      listAutomergeItemIds: vi.fn().mockResolvedValue([]),
    } as unknown as AutomergeIndexManager

    broker = new SyncMessageBroker(
      adapter,
      clientEventHub,
      internalEventHub,
      indexManager,
      pullQueueManager,
      wal,
    )

    adapter.setAccount(accountId)
    adapter.connect('client-peer' as PeerId)
    broker.setSendEnabled(true)
    await broker.setAccount(accountId)
    broker.setOnlineState(true)
  })

  afterEach(async () => {
    adapter.disconnect()
    await broker.shutdown()
  })

  it('Scenario 1: Client creates item -> WAL append -> push to server succeeds -> sent WAL entries removed', async () => {
    const itemId = 'item-create-1' as ItemId
    const docId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))
    const syncData = createTestSyncMessageData()

    // 1. Adapter produces sync message (e.g. from Automerge edit)
    adapter.send({
      type: 'sync',
      senderId: 'client-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: docId,
      data: syncData,
    })

    // 2. Message is immediately durable in WAL
    await vi.waitFor(async () => {
      const entries = await wal.readAll()
      expect(entries.has(itemId)).toBe(true)
    })
    const walEntriesBefore = await wal.readAll()
    const itemEntries = walEntriesBefore.get(itemId)!
    expect(itemEntries).toHaveLength(1)
    expect(itemEntries[0].data).toEqual(syncData)

    // 3. Server poll receives and accepts the push
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
      success: true,
      pushResults: [{ itemId, cursor: 1 }],
      pullResults: [],
    })

    const outcome = await broker.executePoll()
    expect(outcome).toBe('success')

    // 4. Server confirmed write; WAL entry is cleaned up
    const walEntriesAfter = await wal.readAll()
    expect(walEntriesAfter.size).toBe(0)
  })

  it('Scenario 2: Server advances cursor -> Client polls -> receives message and deduplicates in overlap window', async () => {
    const itemId = 'item-pull-1' as ItemId
    const parsedMessages: Uint8Array[] = []
    pullQueueManager.onMessageParsed = (_id, _docId, msg) => {
      parsedMessages.push(msg)
    }

    pullQueueManager.addPendingItem(itemId)

    // First poll receives message with cursor 10
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
      success: true,
      pushResults: [],
      pullResults: [
        {
          itemId,
          hasMore: false,
          nextCursor: 10,
          messages: [{ cursor: 10, encryptedMessage: { iv: 'iv', cipher: 'good-cipher', version: 'legacy' } }],
        },
      ],
    })

    await broker.executePoll()
    expect(parsedMessages).toHaveLength(1)

    // Second poll with overlap window returns same message with cursor 10 -> skipped by dedup cache
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
      success: true,
      pushResults: [],
      pullResults: [
        {
          itemId,
          hasMore: false,
          nextCursor: 10,
          messages: [{ cursor: 10, encryptedMessage: { iv: 'iv', cipher: 'good-cipher', version: 'legacy' } }],
        },
      ],
    })

    await broker.executePoll()
    // Should still be length 1, not 2
    expect(parsedMessages).toHaveLength(1)
  })

  it('Scenario 3: Offline edits accumulate in WAL -> Reconnect -> WAL drains completely', async () => {
    broker.setOnlineState(false)

    const item1 = 'item-offline-1' as ItemId
    const item2 = 'item-offline-2' as ItemId
    const docId1 = interpretAsDocumentId(toAutomergeUrlFromItemId(item1))
    const docId2 = interpretAsDocumentId(toAutomergeUrlFromItemId(item2))
    const syncData = createTestSyncMessageData()

    // Offline edits to two items
    adapter.send({
      type: 'sync',
      senderId: 'client-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: docId1,
      data: syncData,
    })
    adapter.send({
      type: 'sync',
      senderId: 'client-peer' as PeerId,
      targetId: 'vault' as PeerId,
      documentId: docId2,
      data: syncData,
    })

    // Both edits are in WAL
    await vi.waitFor(async () => {
      const entries = await wal.readAll()
      expect(entries.size).toBe(2)
    })

    // Server returns success when reconnecting
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
      success: true,
      pushResults: [
        { itemId: item1, cursor: 5 },
        { itemId: item2, cursor: 6 },
      ],
      pullResults: [],
    })

    broker.setOnlineState(true)
    const outcome = await broker.executePoll()
    expect(outcome).toBe('success')

    // WAL is completely drained
    const entriesAfter = await wal.readAll()
    expect(entriesAfter.size).toBe(0)
  })

  it('Scenario 4: Worker crash during sync -> restart -> WAL retains unsent messages and successfully syncs', async () => {
    // 1. Client creates edit in WAL
    await wal.append('item-crash-recover' as ItemId, new Uint8Array([99, 100]))

    // 2. Simulate worker termination and fresh instance start on same account
    const newWal = new SyncWriteAheadLog(accountId)
    const recoveredEntries = await newWal.readAll()
    expect(recoveredEntries.has('item-crash-recover' as ItemId)).toBe(true)

    // 3. New poller instance reads from recovered WAL and syncs to server
    mockPollSyncBatchWithToken.mockResolvedValueOnce({
      success: true,
      pushResults: [{ itemId: 'item-crash-recover' as ItemId, cursor: 1 }],
      pullResults: [],
    })

    const newPoller = new SyncPoller(pullQueueManager, clientEventHub, internalEventHub, indexManager, newWal)
    newPoller.setAccount(accountId)
    newPoller.setOnlineState(true)

    const outcome = await newPoller.executePoll()
    expect(outcome).toBe('success')

    // 4. Confirmed sent, now empty
    const finalWal = await newWal.readAll()
    expect(finalWal.size).toBe(0)
  })

  it('Scenario 5: Decryption failure -> retry 5 times -> quarantined to manual recovery store', async () => {
    const itemId = 'item-corrupt' as ItemId
    const failureSpy = vi.fn()
    pullQueueManager.onDecryptionFailure = failureSpy

    const corruptMessageResponse = {
      success: true,
      pushResults: [],
      pullResults: [
        {
          itemId,
          hasMore: false,
          nextCursor: 0,
          messages: [{ cursor: 1, encryptedMessage: { iv: 'iv', cipher: 'corrupt-cipher', version: 'legacy' } }],
        },
      ],
    }

    // Pull attempts 1 through 4: stays in pending pull items for retry
    for (let attempt = 1; attempt <= 4; attempt++) {
      mockPollSyncBatchWithToken.mockResolvedValueOnce(corruptMessageResponse)
      await broker.executePoll()
      expect(pullQueueManager.hasPendingPulls()).toBe(true)
      expect(failureSpy).not.toHaveBeenCalled()
    }

    // Attempt 5: permanently fails and invokes onDecryptionFailure
    mockPollSyncBatchWithToken.mockResolvedValueOnce(corruptMessageResponse)
    await broker.executePoll()

    expect(failureSpy).toHaveBeenCalledWith(
      itemId,
      expect.objectContaining({
        message: expect.stringContaining('Permanently failed to parse sync messages after 5 attempts'),
      })
    )
    expect(pullQueueManager.hasPendingPulls()).toBe(false)
  })
})
