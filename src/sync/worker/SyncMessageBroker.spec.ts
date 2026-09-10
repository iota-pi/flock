import { interpretAsDocumentId, type Message } from '@automerge/automerge-repo/slim'

import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'
import type { SyncWriteAheadLog } from './SyncWriteAheadLog'

function createSyncMessage(itemId: string, data: number[]): Message {
  const docId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId as ItemId))
  return {
    type: 'sync',
    senderId: 'client' as any,
    targetId: 'vault' as any,
    documentId: docId,
    data: new Uint8Array(data),
  }
}

describe('SyncMessageBroker', () => {
  let broker: SyncMessageBroker
  let adapter: VaultNetworkAdapter
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub
  let indexManager: AutomergeIndexManager
  let pullQueueManager: SyncPullQueueManager
  let mockWal: SyncWriteAheadLog

  beforeEach(() => {
    vi.clearAllMocks()
    adapter = new VaultNetworkAdapter()
    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    indexManager = {
      addAutomergeItemIdsToIndex: vi.fn().mockResolvedValue(undefined),
    } as unknown as AutomergeIndexManager
    pullQueueManager = {
      setAccount: vi.fn().mockResolvedValue(undefined),
      addPendingItem: vi.fn(),
      exportCursors: vi.fn().mockReturnValue([]),
      importCursors: vi.fn().mockResolvedValue(undefined),
      hasPendingPulls: vi.fn().mockReturnValue(false),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as SyncPullQueueManager
    mockWal = {
      append: vi.fn().mockResolvedValue('entry-1'),
      readAll: vi.fn().mockResolvedValue(new Map()),
      remove: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    } as unknown as SyncWriteAheadLog

    broker = new SyncMessageBroker(
      adapter,
      clientEventHub,
      internalEventHub,
      indexManager,
      pullQueueManager,
      mockWal,
    )
  })

  it('does not write to WAL if send is not enabled or account is not set', () => {
    const msg = createSyncMessage('item123', [1, 2, 3])

    broker.setSendEnabled(false)
    adapter.onMessageToSend?.(msg)

    broker.setSendEnabled(true)
    // Account not set yet
    adapter.onMessageToSend?.(msg)

    expect(mockWal.append).not.toHaveBeenCalled()
  })

  it('appends outgoing sync messages to WAL immediately and triggers flush', async () => {
    const flushSpy = vi.fn()
    broker.onFlushNeeded = flushSpy
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')
    broker.setWal(mockWal)

    const msg = createSyncMessage('item123', [1, 2, 3])
    adapter.onMessageToSend?.(msg)
    await Promise.resolve()

    expect(mockWal.append).toHaveBeenCalledWith('item123', new Uint8Array([1, 2, 3]))
    expect(flushSpy).toHaveBeenCalledTimes(1)
  })

  it('handles request type message by adding pending item and triggering flush', async () => {
    const flushSpy = vi.fn()
    broker.onFlushNeeded = flushSpy
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const docId = interpretAsDocumentId(toAutomergeUrlFromItemId('item-req' as ItemId))
    const reqMsg: Message = {
      type: 'request',
      senderId: 'client' as any,
      targetId: 'vault' as any,
      documentId: docId,
      data: new Uint8Array([]),
    }

    adapter.onMessageToSend?.(reqMsg)

    expect(pullQueueManager.addPendingItem).toHaveBeenCalledWith('item-req')
    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(mockWal.append).not.toHaveBeenCalled()
  })

  it('notifies onItemMessageParsed and delivers message to adapter when pullQueueManager parses a message', async () => {
    const mockOnItemParsed = vi.fn()
    const receiveSpy = vi.spyOn(adapter, 'receiveMessage')
    broker.onItemMessageParsed = mockOnItemParsed
    await broker.setAccount('account-1')

    const docId = interpretAsDocumentId(toAutomergeUrlFromItemId('item-1' as ItemId))
    const msgData = new Uint8Array([1, 2, 3])
    pullQueueManager.onMessageParsed('item-1' as ItemId, docId, msgData)

    expect(mockOnItemParsed).toHaveBeenCalledWith('item-1')
    expect(receiveSpy).toHaveBeenCalledWith(docId, msgData)
  })

  it('does NOT add itemId to indexManager when pullQueueManager parses a message (prevents index resurrection on overlap pulls)', async () => {
    await broker.setAccount('account-1')

    const docId = interpretAsDocumentId(toAutomergeUrlFromItemId('deleted-item-1' as ItemId))
    const msgData = new Uint8Array([4, 5, 6])

    // Simulate parsing an incremental message (e.g. overlap window pull for a deleted item)
    pullQueueManager.onMessageParsed('deleted-item-1' as ItemId, docId, msgData)
    pullQueueManager.onMessageParsed('deleted-item-1' as ItemId, docId, msgData)

    expect(indexManager.addAutomergeItemIdsToIndex).not.toHaveBeenCalled()
  })

  it('abortPoll calls poller.abort instead of poller.shutdown', () => {
    const abortSpy = vi.spyOn((broker as any).syncPoller, 'abort')
    const shutdownSpy = vi.spyOn((broker as any).syncPoller, 'shutdown')

    broker.abortPoll()

    expect(abortSpy).toHaveBeenCalledTimes(1)
    expect(shutdownSpy).not.toHaveBeenCalled()
  })

  it('shuts down syncPoller and pullQueueManager cleanly', async () => {
    const shutdownSpy = vi.spyOn((broker as any).syncPoller, 'shutdown')
    await broker.shutdown()
    expect(shutdownSpy).toHaveBeenCalledTimes(1)
    expect(pullQueueManager.shutdown).toHaveBeenCalledTimes(1)
  })

  it('triggers renegotiation and notifies onWalAppendFailed when WAL append fails', async () => {
    const flushSpy = vi.fn()
    const failureSpy = vi.fn()
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    broker.onFlushNeeded = flushSpy
    broker.onWalAppendFailed = failureSpy
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const appendError = new Error('Disk full')
    vi.mocked(mockWal.append).mockRejectedValueOnce(appendError)
    broker.setWal(mockWal)

    const msg = createSyncMessage('item123', [1, 2, 3])
    adapter.onMessageToSend?.(msg)
    await Promise.resolve()

    expect(mockWal.append).toHaveBeenCalledWith('item123', new Uint8Array([1, 2, 3]))
    expect(renegSpy).toHaveBeenCalledWith(msg.documentId)
    expect(failureSpy).toHaveBeenCalledWith('item123', appendError)
    expect(flushSpy).not.toHaveBeenCalled()
  })

  it('emits quotaExceeded event when WAL append fails with QuotaExceededError', async () => {
    const failureSpy = vi.fn()
    const emitSpy = vi.spyOn(clientEventHub, 'emit')
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    broker.onWalAppendFailed = failureSpy
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    vi.mocked(mockWal.append).mockRejectedValueOnce(quotaError)
    broker.setWal(mockWal)

    const msg = createSyncMessage('item-quota', [4, 5, 6])
    adapter.onMessageToSend?.(msg)
    await Promise.resolve()

    expect(renegSpy).toHaveBeenCalledWith(msg.documentId)
    expect(failureSpy).toHaveBeenCalledWith('item-quota', quotaError)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'quotaExceeded',
        message: expect.stringContaining('quota'),
      })
    )
  })

  it('triggers renegotiation and notifies onWalAppendFailed when WAL is null', async () => {
    const flushSpy = vi.fn()
    const failureSpy = vi.fn()
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    broker.onFlushNeeded = flushSpy
    broker.onWalAppendFailed = failureSpy
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')
    broker.setWal(null)

    const msg = createSyncMessage('item-no-wal', [7, 8, 9])
    adapter.onMessageToSend?.(msg)
    await Promise.resolve()

    expect(renegSpy).toHaveBeenCalledWith(msg.documentId)
    expect(failureSpy).toHaveBeenCalledWith('item-no-wal', expect.any(Error))
    expect(flushSpy).not.toHaveBeenCalled()
  })

  it('triggers renegotiation and forwards onWalEntriesPruned when WAL prunes entries', async () => {
    const prunedSpy = vi.fn()
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    broker.onWalEntriesPruned = prunedSpy

    broker.setWal(mockWal)
    expect(mockWal.onEntriesPruned).toBeDefined()

    // Simulate WAL notifying of pruned items
    mockWal.onEntriesPruned!(['item-1' as ItemId, 'item-2' as ItemId])

    expect(renegSpy).toHaveBeenCalledTimes(2)
    expect(prunedSpy).toHaveBeenCalledWith(['item-1', 'item-2'])
  })
})
