import type { Message } from '@automerge/automerge-repo/slim'
import type { Mock } from 'vitest'

import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { SyncSessionState } from './SyncSessionState'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { toDocumentIdFromItemId } from './utils/automerge'
import type { ItemId } from '@vault/shared'
import type { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { MAX_INCREMENTAL_MESSAGE_BYTES } from '@vault/shared'

function createSyncMessage(itemId: string, data: number[]): Message {
  const docId = toDocumentIdFromItemId(itemId as ItemId)
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
  let session: SyncSessionState
  let adapter: VaultNetworkAdapter
  let pullQueueManager: SyncPullQueueManager
  let mockWal: SyncWriteAheadLog
  let onFlushNeeded: Mock<() => void>
  let requestSnapshot: Mock<(itemIds: ItemId[]) => void>

  beforeEach(() => {
    vi.clearAllMocks()
    onFlushNeeded = vi.fn()
    requestSnapshot = vi.fn()
    session = new SyncSessionState()
    adapter = new VaultNetworkAdapter({ accountId: 'account-1', session, onMessageToSend: () => {} })
    pullQueueManager = {
      cursors: { addPendingItem: vi.fn() },
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as SyncPullQueueManager
    mockWal = {
      append: vi.fn().mockResolvedValue('entry-1'),
      readAll: vi.fn().mockResolvedValue(new Map()),
      remove: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
    } as unknown as SyncWriteAheadLog

    broker = new SyncMessageBroker({
      adapter,
      pullQueueManager,
      session,
      wal: mockWal,
      onFlushNeeded,
      requestSnapshot,
    })
  })

  /** Sends an incremental sync message for the item and reports whether the broker kept it out of the WAL. */
  async function dropsIncrementalSync(itemId: string): Promise<boolean> {
    const appendsBefore = vi.mocked(mockWal.append).mock.calls.length
    broker.send(createSyncMessage(itemId, [7]))
    await Promise.resolve()
    return vi.mocked(mockWal.append).mock.calls.length === appendsBefore
  }

  /** Blocks the item the way a failed WAL append does, then forgets that append */
  async function blockByFailedAppend(itemId: string): Promise<void> {
    session.setLeader(true)
    vi.mocked(mockWal.append).mockRejectedValueOnce(new Error('Disk full'))
    broker.send(createSyncMessage(itemId, [0]))
    await Promise.resolve()
    vi.mocked(mockWal.append).mockClear()
  }

  /** Makes this tab the leader, which writes outgoing messages to the WAL */
  async function startSending(): Promise<void> {
    session.setLeader(true)
  }

  it('does not write to WAL unless this tab is the leader and the session is running', async () => {
    const msg = createSyncMessage('item123', [1, 2, 3])

    broker.send(msg)

    session.setLeader(true)
    session.markShutdown()
    broker.send(msg)
    await Promise.resolve()

    expect(mockWal.append).not.toHaveBeenCalled()
  })

  it('appends outgoing sync messages to WAL immediately and triggers flush', async () => {
    const flushSpy = onFlushNeeded
    session.setLeader(true)

    const msg = createSyncMessage('item123', [1, 2, 3])
    broker.send(msg)
    await Promise.resolve()

    expect(mockWal.append).toHaveBeenCalledWith('item123', new Uint8Array([1, 2, 3]))
    expect(flushSpy).toHaveBeenCalledTimes(1)
  })

  it('falls back to snapshot sync instead of appending oversized messages to the WAL', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    session.setLeader(true)

    const msg = createSyncMessage('item-big', [])
    msg.data = new Uint8Array(MAX_INCREMENTAL_MESSAGE_BYTES + 1)
    broker.send(msg)
    await Promise.resolve()

    expect(mockWal.append).not.toHaveBeenCalled()
    expect(requestSnapshot).toHaveBeenCalledWith(['item-big'])

    // Subsequent incremental messages are dropped until a snapshot succeeds
    expect(await dropsIncrementalSync('item-big')).toBe(true)
    expect(mockWal.append).not.toHaveBeenCalled()

    broker.confirmSnapshot('item-big' as ItemId, ['heads'])
    expect(await dropsIncrementalSync('item-big')).toBe(false)
    warnSpy.mockRestore()
  })

  it('handles request type message by adding pending item and triggering flush', async () => {
    const flushSpy = onFlushNeeded
    session.setLeader(true)

    const docId = toDocumentIdFromItemId('item-req' as ItemId)
    const reqMsg: Message = {
      type: 'request',
      senderId: 'client' as any,
      targetId: 'vault' as any,
      documentId: docId,
      data: new Uint8Array([]),
    }

    broker.send(reqMsg)

    expect(pullQueueManager.cursors.addPendingItem).toHaveBeenCalledWith('item-req')
    expect(flushSpy).toHaveBeenCalledTimes(1)
    expect(mockWal.append).not.toHaveBeenCalled()
  })

  it("leaves stopping the pull queue to the context's lifecycle", () => {
    broker.shutdown()
    expect(pullQueueManager.shutdown).not.toHaveBeenCalled()
  })

  it('triggers renegotiation and requests a snapshot when WAL append fails', async () => {
    const flushSpy = onFlushNeeded
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    session.setLeader(true)

    const appendError = new Error('Disk full')
    vi.mocked(mockWal.append).mockRejectedValueOnce(appendError)

    const msg = createSyncMessage('item123', [1, 2, 3])
    broker.send(msg)
    await Promise.resolve()

    expect(mockWal.append).toHaveBeenCalledWith('item123', new Uint8Array([1, 2, 3]))
    expect(renegSpy).toHaveBeenCalledWith(msg.documentId)
    expect(requestSnapshot).toHaveBeenCalledWith(['item123'])
    expect(flushSpy).not.toHaveBeenCalled()
  })

  it('blocks the item when a WAL append fails with QuotaExceededError', async () => {
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    session.setLeader(true)

    const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError')
    vi.mocked(mockWal.append).mockRejectedValueOnce(quotaError)

    const msg = createSyncMessage('item-quota', [4, 5, 6])
    broker.send(msg)
    await Promise.resolve()

    expect(renegSpy).toHaveBeenCalledWith(msg.documentId)
    expect(requestSnapshot).toHaveBeenCalledWith(['item-quota'])
    expect(broker.getBlockedItemIds()).toEqual(['item-quota'])
  })

  it('flags items for snapshot-only sync and requests snapshots without triggering renegotiation', async () => {
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    await startSending()

    // As when the WAL prunes the items' entries
    broker.fallbackToSnapshot(['item-1' as ItemId, 'item-2' as ItemId])

    expect(renegSpy).not.toHaveBeenCalled()
    expect(requestSnapshot).toHaveBeenCalledWith(['item-1', 'item-2'])
    expect(await dropsIncrementalSync('item-1')).toBe(true)
    expect(await dropsIncrementalSync('item-2')).toBe(true)
    expect(await dropsIncrementalSync('item-3')).toBe(false)
  })

  it('drops outgoing sync messages for snapshot-only items without requesting another snapshot', async () => {
    session.setLeader(true)

    broker.fallbackToSnapshot(['item-1' as ItemId])
    requestSnapshot.mockClear()

    // Outgoing sync message for item-1
    const msg = createSyncMessage('item-1', [1, 2, 3])
    broker.send(msg)
    await Promise.resolve()

    // WAL append should NOT be called for snapshot-only item
    expect(mockWal.append).not.toHaveBeenCalled()
    // It should NOT request another snapshot, to avoid spurious downstream invocations
    expect(requestSnapshot).not.toHaveBeenCalled()
  })

  it('clears snapshot-only flag when a snapshot is confirmed, with or without heads', async () => {
    await startSending()
    broker.fallbackToSnapshot(['item-1' as ItemId, 'item-2' as ItemId])
    expect(await dropsIncrementalSync('item-1')).toBe(true)
    expect(await dropsIncrementalSync('item-2')).toBe(true)

    broker.confirmSnapshot('item-1' as ItemId, ['head-1'])
    expect(await dropsIncrementalSync('item-1')).toBe(false)
    expect(await dropsIncrementalSync('item-2')).toBe(true)

    broker.confirmSnapshot('item-2' as ItemId, undefined)
    expect(await dropsIncrementalSync('item-2')).toBe(false)
  })

  it('confirmSnapshot unblocks the item, ends snapshot-only sync and records heads with the adapter', async () => {
    await startSending()
    const setSyncedHeadsSpy = vi.spyOn(adapter, 'setSyncedHeads')
    const resetRenegSpy = vi.spyOn(adapter, 'resetReNegotiationCircuit')

    const itemId = 'item-snapshot' as ItemId
    const docId = toDocumentIdFromItemId(itemId)

    await blockByFailedAppend(itemId)
    broker.fallbackToSnapshot([itemId])
    expect(broker.getBlockedItemIds()).toEqual([itemId])
    expect(await dropsIncrementalSync(itemId)).toBe(true)

    broker.confirmSnapshot(itemId, ['head-from-snapshot'])
    expect(broker.getBlockedItemIds()).toEqual([])
    expect(setSyncedHeadsSpy).toHaveBeenCalledWith(docId, ['head-from-snapshot'])
    expect(resetRenegSpy).toHaveBeenCalledWith(docId)
    // Neither blocked nor snapshot-only any more, so incremental sync resumes
    expect(await dropsIncrementalSync(itemId)).toBe(false)
  })

  it('records heads from a push without ending snapshot-only sync', async () => {
    await startSending()
    const setSyncedHeadsSpy = vi.spyOn(adapter, 'setSyncedHeads')
    const resetRenegSpy = vi.spyOn(adapter, 'resetReNegotiationCircuit')

    const itemId = 'item-pushed' as ItemId
    const docId = toDocumentIdFromItemId(itemId)

    await blockByFailedAppend(itemId)
    broker.fallbackToSnapshot([itemId])

    broker.recordSyncedHeads(itemId, ['head-from-push'])
    expect(broker.getBlockedItemIds()).toEqual([])
    expect(setSyncedHeadsSpy).toHaveBeenCalledWith(docId, ['head-from-push'])
    expect(resetRenegSpy).toHaveBeenCalledWith(docId)
    // Unblocked but still snapshot-only, so incremental messages stay out of the WAL
    expect(await dropsIncrementalSync(itemId)).toBe(true)
  })

  describe('blocked items and infinite loop prevention on storage quota exceeded', () => {
    it('marks item as blocked when WAL append fails, preventing infinite loops on renegotiation', async () => {
      session.setLeader(true)

      const quotaError = new DOMException('Storage quota exceeded', 'QuotaExceededError')
      vi.mocked(mockWal.append).mockRejectedValueOnce(quotaError)

      // When triggerReNegotiation is called, simulate Automerge immediately emitting a full sync message
      vi.spyOn(adapter, 'triggerReNegotiation').mockImplementation(() => {
        const renegResponseMsg = createSyncMessage('item-loop', [99, 99])
        broker.send(renegResponseMsg)
        return true
      })

      const initialMsg = createSyncMessage('item-loop', [1, 2, 3])
      broker.send(initialMsg)
      await Promise.resolve()

      // The item should now be blocked
      expect(broker.getBlockedItemIds()).toEqual(['item-loop'])

      // Only the first append was attempted; the renegotiation message was dropped because the item was blocked!
      expect(mockWal.append).toHaveBeenCalledTimes(1)
      expect(mockWal.append).toHaveBeenCalledWith('item-loop', new Uint8Array([1, 2, 3]))

      // Further messages while blocked are also dropped
      broker.send(createSyncMessage('item-loop', [4, 5, 6]))
      await Promise.resolve()
      expect(mockWal.append).toHaveBeenCalledTimes(1)
    })

    it('unblocks item when confirmSnapshot is called after successful snapshot upload', async () => {
      await blockByFailedAppend('item-snap')
      expect(broker.getBlockedItemIds()).toEqual(['item-snap'])

      // SnapshotManager succeeds and updates synced heads
      broker.confirmSnapshot('item-snap' as ItemId, ['head-123'])

      expect(broker.getBlockedItemIds()).toEqual([])

      // Now outgoing messages can append to WAL again
      const msg = createSyncMessage('item-snap', [10, 11])
      broker.send(msg)
      await Promise.resolve()

      expect(mockWal.append).toHaveBeenCalledWith('item-snap', new Uint8Array([10, 11]))
    })

    it('successfully appends sync messages to WAL after unblockAllItems unblocks previously blocked items', async () => {
      const flushSpy = onFlushNeeded

      // Block item
      await blockByFailedAppend('item-blocked')
      expect(broker.getBlockedItemIds()).toEqual(['item-blocked'])

      // Message dropped while blocked
      const droppedMsg = createSyncMessage('item-blocked', [1, 2, 3])
      broker.send(droppedMsg)
      await Promise.resolve()
      expect(mockWal.append).not.toHaveBeenCalled()
      expect(flushSpy).not.toHaveBeenCalled()

      // The storage recovery service unblocks every item once storage is available
      broker.unblockAllItems()
      expect(broker.getBlockedItemIds()).toEqual([])

      // Renegotiation message arrives and is appended to WAL
      const recoveredMsg = createSyncMessage('item-blocked', [4, 5, 6])
      broker.send(recoveredMsg)
      await Promise.resolve()

      expect(mockWal.append).toHaveBeenCalledWith('item-blocked', new Uint8Array([4, 5, 6]))
      expect(flushSpy).toHaveBeenCalledTimes(1)
    })

    it('confirming a tombstone snapshot unblocks a single item', async () => {
      await blockByFailedAppend('item-x')
      await blockByFailedAppend('item-y')
      expect(broker.getBlockedItemIds()).toEqual(['item-x', 'item-y'])

      broker.confirmSnapshot('item-x' as ItemId, undefined)
      expect(broker.getBlockedItemIds()).toEqual(['item-y'])
    })
  })
})
