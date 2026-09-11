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
      setLeader = vi.fn()
      getDirtyItemIds = vi.fn().mockReturnValue([])
      persistLastModified = vi.fn().mockResolvedValue(undefined)
    },
  }
})

vi.mock('./SyncOrchestrator', () => {
  return {
    SyncOrchestrator: class MockOrchestrator {
      start = vi.fn().mockResolvedValue(undefined)
      shutdown = vi.fn().mockResolvedValue(undefined)
      setOnlineState = vi.fn()
      setManifestSyncManager = vi.fn()
      online = true
      flush = vi.fn()
    },
  }
})

vi.mock('./stores/LastModifiedStore', () => {
  return {
    LastModifiedStore: class MockLastModifiedStore {
      clear = vi.fn().mockResolvedValue(undefined)
      testStorageAvailable = vi.fn().mockResolvedValue(true)
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
      saveDocToStorage = vi.fn().mockResolvedValue(true)
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
      triggerReNegotiation: vi.fn(),
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

  it('marks items dirty in SnapshotManager when broker reports onWalEntriesPruned', () => {
    expect(mockBroker.onWalEntriesPruned).toBeTypeOf('function')
    mockBroker.onWalEntriesPruned(['pruned-item-1' as ItemId, 'pruned-item-2' as ItemId])
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-1' as ItemId, 0)
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-2' as ItemId, 0)
  })

  it('marks items dirty in SnapshotManager when WAL directly invokes onEntriesPruned', () => {
    expect(context.wal.onEntriesPruned).toBeTypeOf('function')
    context.wal.onEntriesPruned!(['pruned-wal-item' as ItemId])
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-wal-item' as ItemId, 0)
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

  it('forwards orchestrator onLeaderChange to snapshotManager.setLeader', () => {
    expect(context.orchestrator.onLeaderChange).toBeTypeOf('function')
    context.orchestrator.onLeaderChange!(true)
    expect(context.snapshotManager.setLeader).toHaveBeenCalledWith(true)

    context.orchestrator.onLeaderChange!(false)
    expect(context.snapshotManager.setLeader).toHaveBeenCalledWith(false)
  })

  it('forwards broker onItemMessageParsed to clearManualRecovery and deps.onItemMessageParsed', () => {
    const onItemMessageParsedMock = vi.fn()
    const ctx = new SyncWorkerContext({
      accountId: 'test-account',
      repo: {} as Repo,
      adapter: mockAdapter as VaultNetworkAdapter,
      broker: mockBroker as SyncMessageBroker,
      clientEventHub: new ClientEventHub(),
      internalEventHub: new WorkerInternalEventHub(),
      indexStore: { clear: vi.fn() } as unknown as IndexStore,
      indexManager: { ensureIndexDocument: vi.fn().mockResolvedValue(undefined) } as unknown as AutomergeIndexManager,
      cursorStore: { clear: vi.fn() } as unknown as CursorStore,
      pullQueueManager: { getGlobalLatestCursor: vi.fn().mockReturnValue(0) } as unknown as SyncPullQueueManager,
      onItemMessageParsed: onItemMessageParsedMock,
    })

    const clearSpy = vi.spyOn(ctx.itemOperations, 'clearManualRecoveryForItems').mockResolvedValue(undefined)

    expect(mockBroker.onItemMessageParsed).toBeTypeOf('function')
    mockBroker.onItemMessageParsed!('item-parsed-1' as ItemId)

    expect(clearSpy).toHaveBeenCalledWith(['item-parsed-1'])
    expect(onItemMessageParsedMock).toHaveBeenCalledWith('item-parsed-1')
  })

  describe('retrySave', () => {
    it('returns failure if probe testStorageAvailable throws QuotaExceededError', async () => {
      const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError')
      vi.spyOn(context.lastModifiedStore, 'testStorageAvailable').mockRejectedValueOnce(quotaErr)

      const result = await context.retrySave()
      expect(result.success).toBe(false)
      expect(result.error).toContain('still exceeded')
    })

    it('saves dirty documents, triggers renegotiation, persists timestamps, and emits quotaResolved on success', async () => {
      vi.spyOn(context.snapshotManager, 'getDirtyItemIds').mockReturnValue(['item-1' as ItemId, 'item-2' as ItemId])
      const saveDocSpy = vi.spyOn(context.docStore, 'saveDocToStorage').mockResolvedValue(true)
      const persistTimestampsSpy = vi.spyOn(context.snapshotManager, 'persistLastModified').mockResolvedValue(undefined)
      const emitSpy = vi.spyOn(context.clientEventHub, 'emit')

      const result = await context.retrySave()

      expect(result.success).toBe(true)
      expect(saveDocSpy).toHaveBeenCalledWith('item-1' as ItemId)
      expect(saveDocSpy).toHaveBeenCalledWith('item-2' as ItemId)
      expect(mockAdapter.triggerReNegotiation).toHaveBeenCalled()
      expect(persistTimestampsSpy).toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })
  })

  it('wires manifestSyncManager into orchestrator on construction', () => {
    expect(context.orchestrator.setManifestSyncManager).toHaveBeenCalledWith(context.manifestSyncManager)
  })
})
