import { SyncWorkerContext } from './SyncWorkerContext'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import type { ItemId } from 'src/shared/schemas/items'
import type { DocumentId } from '@automerge/automerge-repo/slim'

// ── Internalized store mocks ─────────────────────────────────────────────────

vi.mock('./stores/CursorStore', () => ({
  CursorStore: class MockCursorStore {
    clear = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./stores/IndexStore', () => ({
  IndexStore: class MockIndexStore {
    clear = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./SyncWriteAheadLog', () => ({
  SyncWriteAheadLog: class MockSyncWriteAheadLog {
    clear = vi.fn().mockResolvedValue(undefined)
    handleQuotaExceeded = vi.fn().mockResolvedValue(1)
    append = vi.fn().mockResolvedValue(undefined)
    readAll = vi.fn().mockResolvedValue(new Map())
  },
}))

vi.mock('./docStore/AutomergeIndexManager', () => ({
  AutomergeIndexManager: class MockAutomergeIndexManager {
    ensureIndexDocument = vi.fn().mockResolvedValue(undefined)
    addAutomergeItemIdsToIndex = vi.fn()
    close = vi.fn()
  },
}))

vi.mock('./SyncPullQueueManager', () => ({
  SyncPullQueueManager: class MockSyncPullQueueManager {
    setLockCoordinator = vi.fn()
    getGlobalLatestCursor = vi.fn().mockReturnValue(0)
    shutdown = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./SyncMessageBroker', () => ({
  SyncMessageBroker: class MockSyncMessageBroker {
    unblockAllItems = vi.fn()
    setStorageRecoveryService = vi.fn()
    poller = { executePoll: vi.fn().mockResolvedValue('success'), abort: vi.fn() }
    shutdown = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./VaultEncryptedNetworkAdapter', () => ({
  VaultNetworkAdapter: class MockVaultNetworkAdapter {
    triggerReNegotiation = vi.fn()
    setSyncedHeadsStore = vi.fn()
    setSyncedHeads = vi.fn()
    loadSyncedHeads = vi.fn()
    resetReNegotiationCircuit = vi.fn()
    disconnect = vi.fn()
    setAccount = vi.fn()
  },
}))

vi.mock('./AutomergeRepoManager', () => ({
  AutomergeRepoManager: class MockAutomergeRepoManager {
    init = vi.fn().mockReturnValue({} /* mock Repo */)
    clearLocalData = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
  },
}))

// ── Context-owned manager mocks ──────────────────────────────────────────────

vi.mock('./SnapshotManager', () => ({
  SnapshotManager: class MockSnapshotManager {
    markItemDirty = vi.fn()
    loadLastModified = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
    flushPendingSnapshots = vi.fn().mockResolvedValue({ persisted: 0, total: 0 })
    setLeader = vi.fn()
    getDirtyItemIds = vi.fn().mockReturnValue([])
    persistLastModified = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./SyncOrchestrator', () => ({
  SyncOrchestrator: class MockOrchestrator {
    start = vi.fn().mockResolvedValue(undefined)
    shutdown = vi.fn().mockResolvedValue(undefined)
    setOnlineState = vi.fn()
    setManifestSyncManager = vi.fn()
    claimLeader = vi.fn()
    online = true
    flush = vi.fn()
  },
}))

vi.mock('./stores/LastModifiedStore', () => ({
  LastModifiedStore: class MockLastModifiedStore {
    clear = vi.fn().mockResolvedValue(undefined)
    testStorageAvailable = vi.fn().mockResolvedValue(true)
  },
}))

vi.mock('./stores/SyncedHeadsStore', () => ({
  SyncedHeadsStore: class MockSyncedHeadsStore {
    loadSyncedHeads = vi.fn().mockResolvedValue([])
    saveSyncedHeads = vi.fn().mockResolvedValue(undefined)
    clear = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./docStore', () => ({
  AutomergeDocStore: class MockDocStore {
    shutdown = vi.fn().mockResolvedValue(undefined)
    saveDocToStorage = vi.fn().mockResolvedValue(true)
  },
}))

vi.mock('./ItemOperations', () => ({
  ItemOperations: class MockItemOperations {},
}))

vi.mock('./RecoveryManager', () => ({
  RecoveryManager: class MockRecoveryManager {
    resetRecoveryState = vi.fn()
    unquarantineBatch = vi.fn().mockResolvedValue(undefined)
    reportDecryptionFailure = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./ManifestSyncManager', () => ({
  ManifestSyncManager: class MockManifestSyncManager {
    shutdown = vi.fn()
  },
}))

// ─────────────────────────────────────────────────────────────────────────────

describe('SyncWorkerContext', () => {
  let context: SyncWorkerContext
  let internalEventHub: WorkerInternalEventHub
  let clientEventHub: ClientEventHub

  beforeEach(() => {
    vi.clearAllMocks()
    clientEventHub = new ClientEventHub()
    internalEventHub = new WorkerInternalEventHub()

    context = new SyncWorkerContext({
      accountId: 'test-account',
      clientEventHub,
      internalEventHub,
    })
  })

  it('marks item dirty in SnapshotManager when adapter triggers re-negotiation', () => {
    internalEventHub.emit({ type: 'renegotiationTriggered', documentId: 'test-doc-id' as DocumentId })
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-doc-id' as ItemId, 0)
  })

  it('marks item dirty in SnapshotManager when broker reports WAL append failure', () => {
    internalEventHub.emit({ type: 'walAppendFailed', itemId: 'test-item-id' as ItemId, error: new Error('WAL write failed') })
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('test-item-id' as ItemId, 0)
  })

  it('marks items dirty in SnapshotManager when WAL entries are pruned', () => {
    internalEventHub.emit({ type: 'walEntriesPruned', itemIds: ['pruned-item-1' as ItemId, 'pruned-item-2' as ItemId] })
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-1' as ItemId, 0)
    expect(context.snapshotManager.markItemDirty).toHaveBeenCalledWith('pruned-item-2' as ItemId, 0)
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

  it('forwards leaderChange to snapshotManager.setLeader', () => {
    internalEventHub.emit({ type: 'leaderChange', isLeader: true })
    expect(context.snapshotManager.setLeader).toHaveBeenCalledWith(true)

    internalEventHub.emit({ type: 'leaderChange', isLeader: false })
    expect(context.snapshotManager.setLeader).toHaveBeenCalledWith(false)
  })

  it('clears manual recovery when itemMessageParsed is received', () => {
    const ctxInternalHub = new WorkerInternalEventHub()
    const ctx = new SyncWorkerContext({
      accountId: 'test-account',
      clientEventHub: new ClientEventHub(),
      internalEventHub: ctxInternalHub,
    })

    const clearSpy = vi.spyOn(ctx.recoveryManager, 'unquarantineBatch').mockResolvedValue(undefined)
    ctxInternalHub.emit({ type: 'itemMessageParsed', itemId: 'item-parsed-1' as ItemId })

    expect(clearSpy).toHaveBeenCalledWith(['item-parsed-1'])
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
      expect(context.broker.unblockAllItems).toHaveBeenCalled()
      expect(context.adapter.resetReNegotiationCircuit).toHaveBeenCalled()
      expect(saveDocSpy).toHaveBeenCalledWith('item-1' as ItemId)
      expect(saveDocSpy).toHaveBeenCalledWith('item-2' as ItemId)
      expect(context.adapter.triggerReNegotiation).toHaveBeenCalled()
      expect(persistTimestampsSpy).toHaveBeenCalled()
      expect(emitSpy).toHaveBeenCalledWith({ type: 'quotaResolved' })
    })
  })

  it('wires manifestSyncManager into orchestrator on construction', () => {
    expect(context.orchestrator.setManifestSyncManager).toHaveBeenCalledWith(context.manifestSyncManager)
  })

  it('delegates claimLeader to orchestrator.claimLeader', () => {
    context.claimLeader()
    expect(context.orchestrator.claimLeader).toHaveBeenCalledTimes(1)
  })

  it('triggers wal.handleQuotaExceeded and emits quotaExceeded event in handleQuotaExceeded', async () => {
    const walSpy = vi.spyOn(context.wal, 'handleQuotaExceeded').mockResolvedValue(1)
    const emitSpy = vi.spyOn(context.clientEventHub, 'emit')

    await context.handleQuotaExceeded(new DOMException('Quota exceeded', 'QuotaExceededError'))

    expect(walSpy).toHaveBeenCalledTimes(1)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'quotaExceeded',
        message: expect.stringContaining('Storage quota exceeded'),
      })
    )
  })

  it('delegates initialize and shutdown to lifecycle manager', async () => {
    const startSpy = vi.spyOn(context.lifecycle, 'start')
    const stopSpy = vi.spyOn(context.lifecycle, 'stop')

    await context.initialize()
    expect(startSpy).toHaveBeenCalledTimes(1)

    await context.shutdown({ clearLocalData: true })
    expect(stopSpy).toHaveBeenCalledWith({ clearLocalData: true })
  })

  it('registers expected services in lifecycle manager in correct order', () => {
    const serviceNames = context.lifecycle.getRegisteredServiceNames()
    expect(serviceNames).toEqual([
      'StorageCleanup',
      'RepoManager',
      'VaultNetworkAdapter',
      'SyncMessageBroker',
      'StorageRecoveryService',
      'IndexManager',
      'RecoveryManager',
      'DocStore',
      'SnapshotManager',
      'SyncedHeads',
      'PullQueueManager',
      'ManifestSyncManager',
      'SyncOrchestrator',
    ])
  })

  it('initializes apiClient with refreshAuthToken when provided in config', async () => {
    const mockRefresh = vi.fn().mockResolvedValue('token-123')
    const ctx = new SyncWorkerContext({
      accountId: 'test-account-refresh',
      clientEventHub,
      internalEventHub,
      refreshAuthToken: mockRefresh,
    })

    expect((ctx.apiClient as any).refreshAuth).toBe(mockRefresh)
  })
})

