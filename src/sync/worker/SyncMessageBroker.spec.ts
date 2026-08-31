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

  it('notifies onItemMessageParsed when pullQueueManager parses a message', async () => {
    const mockOnItemParsed = vi.fn()
    broker.onItemMessageParsed = mockOnItemParsed
    await broker.setAccount('account-1')

    const docId = interpretAsDocumentId(toAutomergeUrlFromItemId('item-1' as ItemId))
    pullQueueManager.onMessageParsed('item-1' as ItemId, docId, new Uint8Array([1, 2, 3]))

    expect(mockOnItemParsed).toHaveBeenCalledWith('item-1')
  })

  it('shuts down pullQueueManager cleanly', async () => {
    await broker.shutdown()
    expect(pullQueueManager.shutdown).toHaveBeenCalledTimes(1)
  })
})
