import { interpretAsDocumentId, type Message } from '@automerge/automerge-repo/slim'

import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { toAutomergeUrlFromItemId, toDocumentIdFromItemId } from './utils/automerge'
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
    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    adapter = new VaultNetworkAdapter(internalEventHub)
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
      setInternalEventHub: vi.fn(),
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
    internalEventHub.emit({ type: 'messageToSend', message: msg })

    broker.setSendEnabled(true)
    // Account not set yet
    internalEventHub.emit({ type: 'messageToSend', message: msg })

    expect(mockWal.append).not.toHaveBeenCalled()
  })

  it('appends outgoing sync messages to WAL immediately and triggers flush', async () => {
    const flushSpy = vi.fn()
    internalEventHub.subscribe(e => {
      if (e.type === 'flushNeeded') flushSpy()
    })
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')
    broker.setWal(mockWal)

    const msg = createSyncMessage('item123', [1, 2, 3])
    internalEventHub.emit({ type: 'messageToSend', message: msg })
    await Promise.resolve()

    expect(mockWal.append).toHaveBeenCalledWith('item123', new Uint8Array([1, 2, 3]))
    expect(flushSpy).toHaveBeenCalledTimes(1)
  })

  it('handles request type message by adding pending item and triggering flush', async () => {
    const flushSpy = vi.fn()
    internalEventHub.subscribe(e => {
      if (e.type === 'flushNeeded') flushSpy()
    })
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

    internalEventHub.emit({ type: 'messageToSend', message: reqMsg })

    expect(pullQueueManager.addPendingItem).toHaveBeenCalledWith('item-req')
    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(mockWal.append).not.toHaveBeenCalled()
  })

  it('notifies onItemMessageParsed and delivers message to adapter when messageParsed is emitted', async () => {
    const mockOnItemParsed = vi.fn()
    const receiveSpy = vi.spyOn(adapter, 'receiveMessage')
    internalEventHub.subscribe(e => {
      if (e.type === 'itemMessageParsed') {
        mockOnItemParsed(e.itemId)
      }
    })
    await broker.setAccount('account-1')

    const docId = interpretAsDocumentId(toAutomergeUrlFromItemId('item-1' as ItemId))
    const msgData = new Uint8Array([1, 2, 3])
    internalEventHub.emit({ type: 'messageParsed', itemId: 'item-1' as ItemId, documentId: docId, message: msgData })

    expect(mockOnItemParsed).toHaveBeenCalledWith('item-1')
    expect(receiveSpy).toHaveBeenCalledWith(docId, msgData)
  })

  it('does NOT add itemId to indexManager when messageParsed is emitted (prevents index resurrection on overlap pulls)', async () => {
    await broker.setAccount('account-1')

    const docId = interpretAsDocumentId(toAutomergeUrlFromItemId('deleted-item-1' as ItemId))
    const msgData = new Uint8Array([4, 5, 6])

    // Simulate parsing an incremental message (e.g. overlap window pull for a deleted item)
    internalEventHub.emit({ type: 'messageParsed', itemId: 'deleted-item-1' as ItemId, documentId: docId, message: msgData })
    internalEventHub.emit({ type: 'messageParsed', itemId: 'deleted-item-1' as ItemId, documentId: docId, message: msgData })

    expect(indexManager.addAutomergeItemIdsToIndex).not.toHaveBeenCalled()
  })

  it('shuts down syncPoller and pullQueueManager cleanly', async () => {
    const shutdownSpy = vi.spyOn(broker.poller, 'shutdown')
    await broker.shutdown()
    expect(shutdownSpy).toHaveBeenCalledTimes(1)
    expect(pullQueueManager.shutdown).toHaveBeenCalledTimes(1)
  })

  it('triggers renegotiation and notifies onWalAppendFailed when WAL append fails', async () => {
    const flushSpy = vi.fn()
    const failureSpy = vi.fn()
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    internalEventHub.subscribe(e => {
      if (e.type === 'flushNeeded') flushSpy()
      if (e.type === 'walAppendFailed') failureSpy(e.itemId, e.error)
    })
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const appendError = new Error('Disk full')
    vi.mocked(mockWal.append).mockRejectedValueOnce(appendError)
    broker.setWal(mockWal)

    const msg = createSyncMessage('item123', [1, 2, 3])
    internalEventHub.emit({ type: 'messageToSend', message: msg })
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
    internalEventHub.subscribe(e => {
      if (e.type === 'walAppendFailed') failureSpy(e.itemId, e.error)
    })
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    vi.mocked(mockWal.append).mockRejectedValueOnce(quotaError)
    broker.setWal(mockWal)

    const msg = createSyncMessage('item-quota', [4, 5, 6])
    internalEventHub.emit({ type: 'messageToSend', message: msg })
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
    internalEventHub.subscribe(e => {
      if (e.type === 'flushNeeded') flushSpy()
      if (e.type === 'walAppendFailed') failureSpy(e.itemId, e.error)
    })
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')
    broker.setWal(null)

    const msg = createSyncMessage('item-no-wal', [7, 8, 9])
    internalEventHub.emit({ type: 'messageToSend', message: msg })
    await Promise.resolve()

    expect(renegSpy).toHaveBeenCalledWith(msg.documentId)
    expect(failureSpy).toHaveBeenCalledWith('item-no-wal', expect.any(Error))
    expect(flushSpy).not.toHaveBeenCalled()
  })

  it('flags items for snapshot-only sync without triggering renegotiation when WAL prunes entries', async () => {
    const prunedSpy = vi.fn()
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    internalEventHub.subscribe(e => {
      if (e.type === 'walEntriesPruned') prunedSpy(e.itemIds)
    })

    broker.setWal(mockWal)

    // Simulate WAL notifying of pruned items
    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['item-1' as ItemId, 'item-2' as ItemId] })

    expect(renegSpy).not.toHaveBeenCalled()
    expect(broker.isSnapshotOnly('item-1' as ItemId)).toBe(true)
    expect(broker.isSnapshotOnly('item-2' as ItemId)).toBe(true)
    expect(broker.getSnapshotOnlyItemCount()).toBe(2)
    expect(prunedSpy).toHaveBeenCalledWith(['item-1', 'item-2'])
  })

  it('drops outgoing sync messages for snapshot-only items and forwards to onWalEntriesPruned', async () => {
    const prunedSpy = vi.fn()
    internalEventHub.subscribe(e => {
      if (e.type === 'walEntriesPruned') prunedSpy(e.itemIds)
    })
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')
    broker.setWal(mockWal)

    // Mark item-1 as snapshot-only (via pruned callback)
    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['item-1' as ItemId] })
    prunedSpy.mockClear()
    expect(broker.isSnapshotOnly('item-1' as ItemId)).toBe(true)

    // Outgoing sync message for item-1
    const msg = createSyncMessage('item-1', [1, 2, 3])
    internalEventHub.emit({ type: 'messageToSend', message: msg })
    await Promise.resolve()

    // WAL append should NOT be called for snapshot-only item
    expect(mockWal.append).not.toHaveBeenCalled()
    // It should re-notify onWalEntriesPruned so snapshotManager dirty queue stays fresh
    expect(prunedSpy).toHaveBeenCalledWith(['item-1'])
  })

  it('clears snapshot-only flag when snapshot is confirmed via setSyncedHeads or clearSnapshotOnlyItem', async () => {
    broker.setWal(mockWal)
    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['item-1' as ItemId, 'item-2' as ItemId] })
    expect(broker.isSnapshotOnly('item-1' as ItemId)).toBe(true)
    expect(broker.isSnapshotOnly('item-2' as ItemId)).toBe(true)

    broker.setSyncedHeads('item-1' as ItemId, ['head-1'])
    expect(broker.isSnapshotOnly('item-1' as ItemId)).toBe(false)
    expect(broker.isSnapshotOnly('item-2' as ItemId)).toBe(true)

    broker.clearSnapshotOnlyItem('item-2' as ItemId)
    expect(broker.isSnapshotOnly('item-2' as ItemId)).toBe(false)
    expect(broker.getSnapshotOnlyItemCount()).toBe(0)
  })

  it('handles setSyncedHeads accepting either ItemId or DocumentId correctly', async () => {
    const setSyncedHeadsSpy = vi.spyOn(adapter, 'setSyncedHeads')
    const resetRenegSpy = vi.spyOn(adapter, 'resetReNegotiationCircuit')

    const itemId = 'item-polymorphic' as ItemId
    const docId = toDocumentIdFromItemId(itemId)

    // Test with ItemId: should unblock, clear snapshot-only, and call adapter with DocumentId
    broker.blockItem(itemId)
    broker.markSnapshotOnly(itemId)
    expect(broker.isItemBlocked(itemId)).toBe(true)
    expect(broker.isSnapshotOnly(itemId)).toBe(true)

    broker.setSyncedHeads(itemId, ['head-from-item'])
    expect(broker.isItemBlocked(itemId)).toBe(false)
    expect(broker.isSnapshotOnly(itemId)).toBe(false)
    expect(setSyncedHeadsSpy).toHaveBeenCalledWith(docId, ['head-from-item'])
    expect(resetRenegSpy).toHaveBeenCalledWith(docId)

    // Test with DocumentId: should unblock, clear snapshot-only, and call adapter with DocumentId
    broker.blockItem(itemId)
    broker.markSnapshotOnly(itemId)
    expect(broker.isItemBlocked(itemId)).toBe(true)
    expect(broker.isSnapshotOnly(itemId)).toBe(true)

    broker.setSyncedHeads(docId, ['head-from-doc'])
    expect(broker.isItemBlocked(itemId)).toBe(false)
    expect(broker.isSnapshotOnly(itemId)).toBe(false)
    expect(setSyncedHeadsSpy).toHaveBeenCalledWith(docId, ['head-from-doc'])
    expect(resetRenegSpy).toHaveBeenCalledWith(docId)
  })

  it('clears snapshot-only items on account change and shutdown', async () => {
    broker.setWal(mockWal)
    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['item-1' as ItemId] })
    expect(broker.isSnapshotOnly('item-1' as ItemId)).toBe(true)

    await broker.setAccount('account-2')
    expect(broker.isSnapshotOnly('item-1' as ItemId)).toBe(false)

    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['item-2' as ItemId] })
    expect(broker.isSnapshotOnly('item-2' as ItemId)).toBe(true)

    await broker.shutdown()
    expect(broker.isSnapshotOnly('item-2' as ItemId)).toBe(false)
  })

  describe('blocked items and infinite loop prevention on storage quota exceeded', () => {
    it('marks item as blocked when WAL append fails, preventing infinite loops on renegotiation', async () => {
      broker.setSendEnabled(true)
      await broker.setAccount('account-1')
      broker.setWal(mockWal)

      const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError')
      vi.mocked(mockWal.append).mockRejectedValueOnce(quotaError)

      // When triggerReNegotiation is called, simulate Automerge immediately emitting a full sync message
      vi.spyOn(adapter, 'triggerReNegotiation').mockImplementation(() => {
        const renegResponseMsg = createSyncMessage('item-loop', [99, 99])
        internalEventHub.emit({ type: 'messageToSend', message: renegResponseMsg })
        return true
      })

      const initialMsg = createSyncMessage('item-loop', [1, 2, 3])
      internalEventHub.emit({ type: 'messageToSend', message: initialMsg })
      await Promise.resolve()

      // The item should now be blocked
      expect(broker.isItemBlocked('item-loop' as ItemId)).toBe(true)
      expect(broker.getBlockedItemCount()).toBe(1)

      // Only the first append was attempted; the renegotiation message was dropped because the item was blocked!
      expect(mockWal.append).toHaveBeenCalledTimes(1)
      expect(mockWal.append).toHaveBeenCalledWith('item-loop', new Uint8Array([1, 2, 3]))

      // Further messages while blocked are also dropped
      internalEventHub.emit({ type: 'messageToSend', message: createSyncMessage('item-loop', [4, 5, 6]) })
      await Promise.resolve()
      expect(mockWal.append).toHaveBeenCalledTimes(1)
    })

    it('unblocks item when setSyncedHeads is called after successful snapshot upload', async () => {
      broker.setSendEnabled(true)
      await broker.setAccount('account-1')
      broker.setWal(mockWal)

      // Block the item
      broker.blockItem('item-snap' as ItemId)
      expect(broker.isItemBlocked('item-snap' as ItemId)).toBe(true)

      // SnapshotManager succeeds and updates synced heads
      broker.setSyncedHeads('item-snap' as ItemId, ['head-123'])

      expect(broker.isItemBlocked('item-snap' as ItemId)).toBe(false)
      expect(broker.getBlockedItemCount()).toBe(0)

      // Now outgoing messages can append to WAL again
      const msg = createSyncMessage('item-snap', [10, 11])
      internalEventHub.emit({ type: 'messageToSend', message: msg })
      await Promise.resolve()

      expect(mockWal.append).toHaveBeenCalledWith('item-snap', new Uint8Array([10, 11]))
    })

    it('unblocks all items and triggers renegotiation for previously blocked items when quotaResolved is emitted', async () => {
      broker.setSendEnabled(true)
      await broker.setAccount('account-1')
      broker.setWal(mockWal)

      const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
      const resetCircuitSpy = vi.spyOn(adapter, 'resetReNegotiationCircuit')

      broker.blockItem('item-1' as ItemId)
      broker.blockItem('item-2' as ItemId)
      expect(broker.getBlockedItemCount()).toBe(2)
      expect(broker.getBlockedItemIds()).toEqual(['item-1', 'item-2'])

      // Storage is freed and quotaResolved event is emitted
      clientEventHub.emit({ type: 'quotaResolved' })

      expect(broker.isItemBlocked('item-1' as ItemId)).toBe(false)
      expect(broker.isItemBlocked('item-2' as ItemId)).toBe(false)
      expect(broker.getBlockedItemCount()).toBe(0)
      expect(broker.getBlockedItemIds()).toEqual([])

      expect(resetCircuitSpy).toHaveBeenCalled()
      expect(renegSpy).toHaveBeenCalledWith(toDocumentIdFromItemId('item-1' as ItemId))
      expect(renegSpy).toHaveBeenCalledWith(toDocumentIdFromItemId('item-2' as ItemId))
    })

    it('successfully appends sync messages to WAL after quotaResolved unblocks previously blocked items', async () => {
      const flushSpy = vi.fn()
      internalEventHub.subscribe(e => {
        if (e.type === 'flushNeeded') flushSpy()
      })
      broker.setSendEnabled(true)
      await broker.setAccount('account-1')
      broker.setWal(mockWal)

      // Block item
      broker.blockItem('item-blocked' as ItemId)
      expect(broker.isItemBlocked('item-blocked' as ItemId)).toBe(true)

      // Message dropped while blocked
      const droppedMsg = createSyncMessage('item-blocked', [1, 2, 3])
      internalEventHub.emit({ type: 'messageToSend', message: droppedMsg })
      await Promise.resolve()
      expect(mockWal.append).not.toHaveBeenCalled()
      expect(flushSpy).not.toHaveBeenCalled()

      // Resolve quota
      clientEventHub.emit({ type: 'quotaResolved' })
      expect(broker.isItemBlocked('item-blocked' as ItemId)).toBe(false)

      // Renegotiation message arrives and is appended to WAL
      const recoveredMsg = createSyncMessage('item-blocked', [4, 5, 6])
      internalEventHub.emit({ type: 'messageToSend', message: recoveredMsg })
      await Promise.resolve()

      expect(mockWal.append).toHaveBeenCalledWith('item-blocked', new Uint8Array([4, 5, 6]))
      expect(flushSpy).toHaveBeenCalledTimes(1)
    })

    it('explicit unblockItem unblocks single item', () => {
      broker.blockItem('item-x' as ItemId)
      broker.blockItem('item-y' as ItemId)
      expect(broker.isItemBlocked('item-x' as ItemId)).toBe(true)

      broker.unblockItem('item-x' as ItemId)
      expect(broker.isItemBlocked('item-x' as ItemId)).toBe(false)
      expect(broker.isItemBlocked('item-y' as ItemId)).toBe(true)
    })
  })
})
