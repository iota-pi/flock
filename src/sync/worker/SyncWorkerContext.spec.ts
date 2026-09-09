import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SyncWorkerContext } from './SyncWorkerContext'
import type { Repo } from '@automerge/automerge-repo/slim'
import type { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import type { IndexStore } from './stores/IndexStore'
import type { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { CursorStore } from './stores/CursorStore'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import type { ItemId } from 'src/shared/schemas/items'

vi.mock('./SnapshotManager', () => {
  return {
    SnapshotManager: class MockSnapshotManager {
      markItemDirty = vi.fn()
      loadLastModified = vi.fn().mockResolvedValue(undefined)
      shutdown = vi.fn().mockResolvedValue(undefined)
      flushPendingSnapshots = vi.fn().mockResolvedValue({ persisted: 0, total: 0 })
    },
  }
})

vi.mock('./SyncOrchestrator', () => {
  return {
    SyncOrchestrator: class MockOrchestrator {
      start = vi.fn().mockResolvedValue(undefined)
      shutdown = vi.fn().mockResolvedValue(undefined)
      setOnlineState = vi.fn()
    },
  }
})

vi.mock('./stores/LastModifiedStore', () => {
  return {
    LastModifiedStore: class MockLastModifiedStore {
      clear = vi.fn().mockResolvedValue(undefined)
    },
  }
})

vi.mock('./stores/SyncedHeadsStore', () => {
  return {
    SyncedHeadsStore: class MockSyncedHeadsStore {
      loadSyncedHeads = vi.fn().mockResolvedValue([])
      saveSyncedHeads = vi.fn().mockResolvedValue(undefined)
      clear = vi.fn().mockResolvedValue(undefined)
    },
  }
})

vi.mock('./docStore', () => {
  return {
    AutomergeDocStore: class MockDocStore {
      shutdown = vi.fn().mockResolvedValue(undefined)
    },
  }
})

vi.mock('./ItemOperations', () => {
  return {
    ItemOperations: class MockItemOperations {
      resetRecoveryState = vi.fn()
      clearManualRecoveryForItems = vi.fn().mockResolvedValue(undefined)
      reportDecryptionFailure = vi.fn().mockResolvedValue(undefined)
    },
  }
})

vi.mock('./ManifestSyncManager', () => {
  return {
    ManifestSyncManager: class MockManifestSyncManager {},
  }
})

describe('SyncWorkerContext', () => {
  let mockAdapter: any
  let mockBroker: any
  let context: SyncWorkerContext

  beforeEach(() => {
    vi.clearAllMocks()
    mockAdapter = {
      onReNegotiationTriggered: null,
      setSyncedHeadsStore: vi.fn(),
      setSyncedHeads: vi.fn(),
      loadSyncedHeads: vi.fn(),
    }
    mockBroker = {
      onItemMessageParsed: null,
      onWalAppendFailed: null,
    }

    const mockRepo = {} as Repo
    const clientEventHub = new ClientEventHub()
    const internalEventHub = new WorkerInternalEventHub()
    const mockIndexStore = { clear: vi.fn() } as unknown as IndexStore
    const mockIndexManager = {
      ensureIndexDocument: vi.fn().mockResolvedValue(undefined),
      addAutomergeItemIdsToIndex: vi.fn(),
    } as unknown as AutomergeIndexManager
    const mockCursorStore = { clear: vi.fn() } as unknown as CursorStore
    const mockPullQueueManager = {
      onDecryptionFailure: null,
      getGlobalLatestCursor: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as SyncPullQueueManager

    context = new SyncWorkerContext({
      accountId: 'test-account',
      repo: mockRepo,
      adapter: mockAdapter as VaultNetworkAdapter,
      broker: mockBroker as SyncMessageBroker,
      clientEventHub,
      internalEventHub,
      indexStore: mockIndexStore,
      indexManager: mockIndexManager,
      cursorStore: mockCursorStore,
      pullQueueManager: mockPullQueueManager,
    })
  })

  it('marks item dirty in SnapshotManager when adapter triggers re-negotiation', () => {
    expect(mockAdapter.onReNegotiationTriggered).toBeTypeOf('function')
    mockAdapter.onReNegotiationTriggered('test-doc-id')
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-doc-id' as ItemId, 0)
  })

  it('marks item dirty in SnapshotManager when broker reports WAL append failure', () => {
    expect(mockBroker.onWalAppendFailed).toBeTypeOf('function')
    mockBroker.onWalAppendFailed('test-item-id' as ItemId, new Error('WAL write failed'))
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-item-id' as ItemId, 0)
  })

  it('forwards clearLocalData options to pullQueueManager and snapshotManager on shutdown', async () => {
    await context.shutdown({ clearLocalData: true })

    expect(context.pullQueueManager.shutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(context.snapshotManager.shutdown).toHaveBeenCalledWith({ clearLocalData: true })
    expect(context.orchestrator.shutdown).toHaveBeenCalled()
    expect(context.docStore.shutdown).toHaveBeenCalled()
    expect(context.indexStore.clear).toHaveBeenCalled()
    expect(context.cursorStore.clear).toHaveBeenCalled()
  })

  it('shuts down cleanly without clearLocalData', async () => {
    await context.shutdown()

    expect(context.pullQueueManager.shutdown).toHaveBeenCalledWith(undefined)
    expect(context.snapshotManager.shutdown).toHaveBeenCalledWith(undefined)
    expect(context.indexStore.clear).not.toHaveBeenCalled()
    expect(context.cursorStore.clear).not.toHaveBeenCalled()
  })
})
