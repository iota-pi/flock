import type { Mock } from 'vitest'
import type { Message } from '@automerge/automerge-repo/slim'
import {
  type MockLocalforage,
  createMockLocalForage,
  mockLocalForage,
} from './__test__/testUtils'

import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncMessageBroker } from './SyncMessageBroker'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { SyncSessionState } from './SyncSessionState'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import type { ItemId } from '@vault/shared'
import { clearAccountStoreInstancesCacheForTesting } from '../shared/createAccountStore'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import { toDocumentIdFromItemId } from './utils/automerge'

const mockStores = new Map<string, MockLocalforage>()

const createLocalForageInstance = (opts: { name: string; storeName: string }) => {
  const key = `${opts.name}:${opts.storeName}`
  if (!mockStores.has(key)) {
    mockStores.set(key, createMockLocalForage(opts))
  }
  return mockStores.get(key)
}

function createTestSyncMessage(itemId: string, data: Uint8Array = new Uint8Array([1, 2, 3])): Message {
  const docId = toDocumentIdFromItemId(itemId as ItemId)
  return {
    type: 'sync',
    senderId: 'client' as any,
    targetId: 'vault' as any,
    documentId: docId,
    data,
  }
}

describe('WAL Thrashing Prevention (>2000 Offline Items)', () => {
  const accountId = 'flight-test-account'
  let onPruned: Mock<(itemIds: ItemId[]) => void>
  let pullQueueManager: SyncPullQueueManager
  let wal: SyncWriteAheadLog
  let adapter: VaultNetworkAdapter
  let broker: SyncMessageBroker

  beforeEach(async () => {
    mockLocalForage(createLocalForageInstance)
    vi.clearAllMocks()
    mockStores.clear()
    clearAccountStoreInstancesCacheForTesting()

    onPruned = vi.fn()
    // This tab is the leader, which writes outgoing messages to the WAL
    const session = new SyncSessionState({ isLeader: true })
    adapter = new VaultNetworkAdapter({ accountId, session, onMessageToSend: message => broker.send(message) })
    adapter.connect('peer-1' as any)

    pullQueueManager = {
      addPendingItem: vi.fn(),
      exportCursors: vi.fn().mockReturnValue([]),
      importCursors: vi.fn().mockResolvedValue(undefined),
      loadCursors: vi.fn().mockResolvedValue(undefined),
      hasImmediatePendingPulls: vi.fn().mockReturnValue(false),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as SyncPullQueueManager

    // Wired as the context wires them
    wal = new SyncWriteAheadLog(accountId, {
      onEntriesPruned: itemIds => {
        onPruned(itemIds)
        broker.fallbackToSnapshot(itemIds)
      },
    })
    broker = new SyncMessageBroker({
      adapter,
      pullQueueManager,
      session,
      wal,
      onFlushNeeded: () => {},
      requestSnapshot: () => {},
    })
  })

  async function sendIncrementalEdits(itemIds: ItemId[]): Promise<void> {
    for (const itemId of itemIds) {
      await (broker as any).handleOutgoingMessage(createTestSyncMessage(itemId))
    }
  }

  it('prevents infinite thrashing loop by flagging pruned items for snapshot-only sync without renegotiation', async () => {
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    const walAppendSpy = vi.spyOn(wal, 'append')
    const onPrunedSpy = onPruned

    // Step 1: Pre-populate WAL with MAX_ENTRIES (2000) unique items directly in storage
    const store = mockStores.get(`test-vault-wal-${accountId}:wal-entries`)!
    for (let i = 0; i < SYNC_BATCH_SIZES.walMax; i++) {
      const id = `entry-${i}`
      const itemId = `offline-item-${i}` as ItemId
      store.store.set(id, {
        id,
        itemId,
        data: new Uint8Array([1]),
        createdAt: 1000 + i,
        seq: i + 1,
      })
    }

    expect(await store.length()).toBe(2000)

    // Step 2: User edits a 2001st item while offline
    const newMsg = createTestSyncMessage('offline-item-2000')
    await (broker as any).handleOutgoingMessage(newMsg)

    // Step 3: Verify that:
    // - Oldest 100 items (offline-item-0 to offline-item-99) were pruned
    // - onWalEntriesPruned was called with the pruned items
    expect(onPrunedSpy).toHaveBeenCalledTimes(1)
    const prunedItems = onPrunedSpy.mock.calls[0][0] as ItemId[]
    expect(prunedItems).toHaveLength(100)
    expect(prunedItems).toContain('offline-item-0')
    expect(prunedItems).toContain('offline-item-99')

    // Step 4: CRITICAL - adapter.triggerReNegotiation MUST NOT have been called!
    // Calling triggerReNegotiation causes Automerge to regenerate messages into WAL in an infinite loop.
    expect(renegSpy).not.toHaveBeenCalled()

    // Step 5: WAL length is bounded at 2000 - 100 + 1 = 1901 entries
    expect(await store.length()).toBe(1901)
    // The newly appended item is present
    expect(Array.from(store.store.values()).some(e => e.itemId === 'offline-item-2000')).toBe(true)

    // Step 6: All 100 pruned items are now flagged as snapshot-only, so their incremental messages are dropped
    walAppendSpy.mockClear()
    await sendIncrementalEdits(prunedItems)
    expect(walAppendSpy).not.toHaveBeenCalled()
    expect(await store.length()).toBe(1901)

    // Step 7: If the user edits one of the pruned items again while still offline:
    // The broker should DROP the incremental sync message (NOT append to WAL),
    // without re-emitting walEntriesPruned (avoiding spurious downstream invocations).
    walAppendSpy.mockClear()
    onPrunedSpy.mockClear()

    const prunedItemEditMsg = createTestSyncMessage('offline-item-5')
    await (broker as any).handleOutgoingMessage(prunedItemEditMsg)

    // WAL append should NOT have been called for the snapshot-only item!
    expect(walAppendSpy).not.toHaveBeenCalled()
    // Storage size remains at 1901 (no growth / thrashing)
    expect(await store.length()).toBe(1901)
    // walEntriesPruned must NOT be re-emitted
    expect(onPrunedSpy).not.toHaveBeenCalled()

    // Step 8: When the snapshot is uploaded to server upon reconnecting:
    // broker.confirmSnapshot is called, removing the item from snapshot-only mode.
    broker.confirmSnapshot('offline-item-5' as ItemId, ['server-head-1'])

    // Now future edits to offline-item-5 can append to WAL normally
    const postSnapshotEditMsg = createTestSyncMessage('offline-item-5')
    await (broker as any).handleOutgoingMessage(postSnapshotEditMsg)

    expect(walAppendSpy).toHaveBeenCalledWith('offline-item-5', expect.any(Uint8Array))
    expect(await store.length()).toBe(1902)

    // The other 99 pruned items are still snapshot-only
    walAppendSpy.mockClear()
    await sendIncrementalEdits(prunedItems.filter(itemId => itemId !== 'offline-item-5'))
    expect(walAppendSpy).not.toHaveBeenCalled()
    expect(await store.length()).toBe(1902)
  })

  it('handles extensive offline edits (>2050 items) without infinite recursion or stack overflow', async () => {
    const prunedItems: ItemId[] = []
    onPruned.mockImplementation(itemIds => {
      prunedItems.push(...itemIds)
    })
    const store = mockStores.get(`test-vault-wal-${accountId}:wal-entries`)!
    for (let i = 0; i < 1950; i++) {
      const id = `entry-${i}`
      store.store.set(id, {
        id,
        itemId: `item-${i}` as ItemId,
        data: new Uint8Array([1]),
        createdAt: 1000 + i,
        seq: i + 1,
      })
    }

    // Append 100 more items (crossing the 2000 threshold)
    for (let i = 1950; i < 2050; i++) {
      const msg = createTestSyncMessage(`item-${i}`)
      await (broker as any).handleOutgoingMessage(msg)
    }

    // WAL size must stay strictly bounded under or equal to MAX_ENTRIES
    const finalLength = await store.length()
    expect(finalLength).toBeLessThanOrEqual(SYNC_BATCH_SIZES.walMax)
    // Items that crossed threshold were safely quarantined into snapshot-only mode
    expect(new Set(prunedItems).size).toBeGreaterThanOrEqual(100)
    const walAppendSpy = vi.spyOn(wal, 'append')
    await sendIncrementalEdits(prunedItems)
    expect(walAppendSpy).not.toHaveBeenCalled()
  })
})
