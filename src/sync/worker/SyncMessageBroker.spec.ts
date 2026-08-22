import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncMessageBroker } from './SyncMessageBroker'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { persistSyncMessages } from '../shared/VaultPersistence'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { interpretAsDocumentId, type Message } from '@automerge/automerge-repo/slim'
import type { ItemId } from 'src/shared/schemas/items'

vi.mock('../shared/VaultPersistence', () => ({
  persistSyncMessages: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../api/syncHealthCoordinator', () => ({
  clearManualRecoveryForItems: vi.fn().mockResolvedValue(undefined),
}))

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

    broker = new SyncMessageBroker(
      adapter,
      clientEventHub,
      internalEventHub,
      indexManager,
      pullQueueManager,
    )
  })

  it('does not buffer writes if send is not enabled or account is not set', () => {
    const msg = createSyncMessage('item123', [1, 2, 3])

    broker.setSendEnabled(false)
    adapter.onMessageToSend?.(msg)

    broker.setSendEnabled(true)
    // Account not set yet
    adapter.onMessageToSend?.(msg)

    expect(persistSyncMessages).not.toHaveBeenCalled()
  })

  it('persists pending writes for the active account when flushed', async () => {
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const msg = createSyncMessage('item123', [1, 2, 3])
    adapter.onMessageToSend?.(msg)

    // Shutdown flushes pending writes
    await broker.shutdown()

    expect(persistSyncMessages).toHaveBeenCalledWith('account-1', expect.any(Map))
    const calls = vi.mocked(persistSyncMessages).mock.calls
    const writtenMap = calls[0][1] as Map<string, Uint8Array[]>
    expect(writtenMap.has('item123')).toBe(true)
    expect(writtenMap.get('item123')?.[0]).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('prevents cross-account data leakage when messages arrive during account switch', async () => {
    broker.setSendEnabled(true)
    await broker.setAccount('account-A')

    const msgA = createSyncMessage('itemA', [10, 20])

    let resolvePersist: (() => void) | null = null
    const persistDeferred = new Promise<void>((resolve) => {
      resolvePersist = resolve
    })

    // First persistSyncMessages will block until resolvePersist is called
    vi.mocked(persistSyncMessages).mockImplementationOnce(() => persistDeferred)

    // Initial message for account A
    adapter.onMessageToSend?.(msgA)

    // Start account switch to account B (this calls persistPendingWrites and awaits)
    const switchPromise = broker.setAccount('account-B')

    // While persistPendingWrites for account A is in flight, another message arrives
    const msgA2 = createSyncMessage('itemA2', [30, 40])
    adapter.onMessageToSend?.(msgA2)

    // Resolve the first persist
    resolvePersist!()
    await switchPromise

    // Now broker.account is account-B
    // Now trigger flush of remaining writes
    await broker.shutdown()

    // Verify all persistSyncMessages calls
    const calls = vi.mocked(persistSyncMessages).mock.calls
    expect(calls.length).toBe(2)

    // First call was for account-A with itemA
    expect(calls[0][0]).toBe('account-A')
    const firstMap = calls[0][1] as Map<string, Uint8Array[]>
    expect(firstMap.has('itemA')).toBe(true)

    // Second call should ALSO be for account-A with itemA2, NOT account-B!
    expect(calls[1][0]).toBe('account-A')
    const secondMap = calls[1][1] as Map<string, Uint8Array[]>
    expect(secondMap.has('itemA2')).toBe(true)
    expect(secondMap.has('itemA')).toBe(false)
  })

  it('restores writes if persistSyncMessages fails', async () => {
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const msg = createSyncMessage('item1', [1])
    adapter.onMessageToSend?.(msg)

    vi.mocked(persistSyncMessages).mockRejectedValueOnce(new Error('Network error'))

    await expect(broker.shutdown()).rejects.toThrow('Network error')

    // Next successful call to persist should retry the failed writes
    vi.mocked(persistSyncMessages).mockResolvedValueOnce(undefined)
    await broker.shutdown()

    expect(persistSyncMessages).toHaveBeenCalledTimes(2)
    const secondCall = vi.mocked(persistSyncMessages).mock.calls[1]
    expect(secondCall[0]).toBe('account-1')
    const map = secondCall[1] as Map<string, Uint8Array[]>
    expect(map.has('item1')).toBe(true)
  })

  it('persists pending writes during shutdown even if pullQueueManager.shutdown throws', async () => {
    broker.setSendEnabled(true)
    await broker.setAccount('account-1')

    const msg = createSyncMessage('item1', [1])
    adapter.onMessageToSend?.(msg)

    vi.mocked(pullQueueManager.shutdown).mockRejectedValueOnce(new Error('PullQueue shutdown error'))

    await expect(broker.shutdown()).rejects.toThrow('PullQueue shutdown error')

    expect(persistSyncMessages).toHaveBeenCalledWith('account-1', expect.any(Map))
    const calls = vi.mocked(persistSyncMessages).mock.calls
    const writtenMap = calls[0][1] as Map<string, Uint8Array[]>
    expect(writtenMap.has('item1')).toBe(true)
  })
})

