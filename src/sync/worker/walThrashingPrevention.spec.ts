import { interpretAsDocumentId, type Message } from '@automerge/automerge-repo/slim'

import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncMessageBroker } from './SyncMessageBroker'
import { SyncWriteAheadLog, clearWalInstancesCacheForTesting } from './SyncWriteAheadLog'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { ItemId } from 'src/shared/schemas/items'

const { mockStores } = vi.hoisted(() => {
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

  return {
    mockStores: new Map<string, MockLocalForageInstance>(),
  }
})

vi.mock('localforage', () => ({
  default: {
    createInstance: vi.fn().mockImplementation((opts: { name: string; storeName: string }) => {
      const key = `${opts.name}:${opts.storeName}`
      if (!mockStores.has(key)) {
        const store = new Map<string, any>()
        mockStores.set(key, {
          store,
          getItem: vi.fn().mockImplementation(async (k: string) => store.get(k) ?? null),
          setItem: vi.fn().mockImplementation(async (k: string, v: any) => {
            store.set(k, v)
            return v
          }),
          removeItem: vi.fn().mockImplementation(async (k: string) => {
            store.delete(k)
          }),
          clear: vi.fn().mockImplementation(async () => {
            store.clear()
          }),
          keys: vi.fn().mockImplementation(async () => Array.from(store.keys())),
          length: vi.fn().mockImplementation(async () => store.size),
          iterate: vi.fn().mockImplementation(async (fn: (val: any, k: string) => void) => {
            for (const [k, val] of store.entries()) {
              fn(val, k)
            }
          }),
        } as any)
      }
      return mockStores.get(key)
    }),
  },
}))

function createTestSyncMessage(itemId: string, data: Uint8Array = new Uint8Array([1, 2, 3])): Message {
  const docId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId as ItemId))
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
  let clientEventHub: ClientEventHub
  let internalEventHub: WorkerInternalEventHub
  let pullQueueManager: SyncPullQueueManager
  let wal: SyncWriteAheadLog
  let adapter: VaultNetworkAdapter
  let broker: SyncMessageBroker

  beforeEach(async () => {
    vi.clearAllMocks()
    mockStores.clear()
    clearWalInstancesCacheForTesting()

    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()
    adapter = new VaultNetworkAdapter()
    adapter.connect('peer-1' as any)

    pullQueueManager = {
      setAccount: vi.fn().mockResolvedValue(undefined),
      addPendingItem: vi.fn(),
      exportCursors: vi.fn().mockReturnValue([]),
      importCursors: vi.fn().mockResolvedValue(undefined),
      loadCursors: vi.fn().mockResolvedValue(undefined),
      resetCursors: vi.fn().mockResolvedValue(undefined),
      hasPendingPulls: vi.fn().mockReturnValue(false),
      hasImmediatePendingPulls: vi.fn().mockReturnValue(false),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as SyncPullQueueManager

    wal = new SyncWriteAheadLog(accountId)
    broker = new SyncMessageBroker(
      adapter,
      clientEventHub,
      internalEventHub,
      undefined,
      pullQueueManager,
      wal,
    )

    broker.setSendEnabled(true)
    await broker.setAccount(accountId)
  })

  it('prevents infinite thrashing loop by flagging pruned items for snapshot-only sync without renegotiation', async () => {
    const renegSpy = vi.spyOn(adapter, 'triggerReNegotiation')
    const walAppendSpy = vi.spyOn(wal, 'append')
    const onPrunedSpy = vi.fn()
    internalEventHub.subscribe(e => {
      if (e.type === 'walEntriesPruned') onPrunedSpy(e.itemIds)
    })

    // Step 1: Pre-populate WAL with MAX_ENTRIES (2000) unique items directly in storage
    const store = mockStores.get(`FlockVault_SyncWAL_${accountId}:wal-entries`)!
    for (let i = 0; i < SyncWriteAheadLog.MAX_ENTRIES; i++) {
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
    // - Compaction ran (2000 unique items -> cannot reduce)
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

    // Step 5: All 100 pruned items are now flagged as snapshot-only in the broker
    for (let i = 0; i < 100; i++) {
      expect(broker.isSnapshotOnly(`offline-item-${i}` as ItemId)).toBe(true)
    }
    expect(broker.getSnapshotOnlyItemCount()).toBe(100)

    // Step 6: WAL length is bounded at 2000 - 100 + 1 = 1901 entries
    expect(await store.length()).toBe(1901)
    // The newly appended item is present
    expect(Array.from(store.store.values()).some(e => e.itemId === 'offline-item-2000')).toBe(true)

    // Step 7: If the user edits one of the pruned items again while still offline:
    // The broker should DROP the incremental sync message (NOT append to WAL),
    // and re-notify onWalEntriesPruned so SnapshotManager dirty queue is refreshed.
    walAppendSpy.mockClear()
    onPrunedSpy.mockClear()

    const prunedItemEditMsg = createTestSyncMessage('offline-item-5')
    await (broker as any).handleOutgoingMessage(prunedItemEditMsg)

    // WAL append should NOT have been called for the snapshot-only item!
    expect(walAppendSpy).not.toHaveBeenCalled()
    // Storage size remains at 1901 (no growth / thrashing)
    expect(await store.length()).toBe(1901)
    // onWalEntriesPruned re-notified for dirty tracking
    expect(onPrunedSpy).toHaveBeenCalledWith(['offline-item-5'])

    // Step 8: When the snapshot is uploaded to server upon reconnecting:
    // broker.setSyncedHeads is called, removing the item from snapshot-only mode.
    broker.setSyncedHeads('offline-item-5' as ItemId, ['server-head-1'])
    expect(broker.isSnapshotOnly('offline-item-5' as ItemId)).toBe(false)
    expect(broker.getSnapshotOnlyItemCount()).toBe(99)

    // Now future edits to offline-item-5 can append to WAL normally
    const postSnapshotEditMsg = createTestSyncMessage('offline-item-5')
    await (broker as any).handleOutgoingMessage(postSnapshotEditMsg)

    expect(walAppendSpy).toHaveBeenCalledWith('offline-item-5', expect.any(Uint8Array))
    expect(await store.length()).toBe(1902)
  })

  it('handles extensive offline edits (>2050 items) without infinite recursion or stack overflow', async () => {
    const store = mockStores.get(`FlockVault_SyncWAL_${accountId}:wal-entries`)!
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
    expect(finalLength).toBeLessThanOrEqual(SyncWriteAheadLog.MAX_ENTRIES)
    // Items that crossed threshold were safely quarantined into snapshot-only mode
    expect(broker.getSnapshotOnlyItemCount()).toBeGreaterThanOrEqual(100)
  })
})
