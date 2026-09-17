import { SyncWorker } from './sync.worker'

// Mock Automerge WASM
vi.mock('@automerge/automerge/slim', () => ({
  initializeWasm: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
  from: vi.fn(),
}))

vi.mock('@automerge/automerge/automerge.wasm?url', () => ({
  default: 'mock-wasm-url'
}))

vi.mock('../../api/vault', () => ({
  initWorkerVault: vi.fn().mockResolvedValue(undefined),
}))

// normalizeItemSnapshot is used inside SyncWorker.bindItemHandle; mock it so tests
// receive a clean item shape without needing real Automerge doc parsing.
vi.mock('./docStore', () => ({
  normalizeItemSnapshot: vi.fn().mockImplementation((id: string, doc: unknown) => (doc ? ({ ...(doc as object), id }) : null)),
  RepoDoc: undefined,
  AutomergeDocStore: class {},
}))

// Mock SyncWorkerContext — the worker delegates all service management here
const mockContextInitialize = vi.fn().mockResolvedValue(undefined)
const mockContextShutdown = vi.fn().mockResolvedValue(undefined)
const mockContextClaimLeader = vi.fn()
const mockContextRetrySave = vi.fn().mockResolvedValue({ success: true })
const mockRepoManagerPauseBroadcastSync = vi.fn()
const mockRepoManagerResumeBroadcastSync = vi.fn()
const mockBrokerSetAccount = vi.fn().mockResolvedValue(undefined)
const mockAdapterSetAccount = vi.fn()
const mockIndexManagerListAutomergeItemIds = vi.fn().mockResolvedValue([])
const mockIndexManagerAddAutomergeItemIdsToIndex = vi.fn().mockResolvedValue(undefined)
const mockRecoveryManagerUnquarantineBatch = vi.fn().mockResolvedValue(undefined)
const mockItemOperationsMutateItem = vi.fn().mockResolvedValue(undefined)
const mockRecoveryManagerListRecoveryItems = vi.fn().mockResolvedValue([])
const mockOrchestratorSetOnlineState = vi.fn()
const mockOrchestratorFlush = vi.fn()
const mockSnapshotManagerOnOnlineStateChange = vi.fn()
const mockDocStoreOnDocHandleReplaced = vi.fn()

vi.mock('./SyncWorkerContext', () => {
  return {
    SyncWorkerContext: class MockSyncWorkerContext {
      // Public properties accessed by SyncWorker
      accountId = 'test-account'
      repo = { find: mockRepoFind, handles: {} }
      repoManager = {
        pauseBroadcastSync: mockRepoManagerPauseBroadcastSync,
        resumeBroadcastSync: mockRepoManagerResumeBroadcastSync,
      }
      broker = {
        setAccount: mockBrokerSetAccount,
      }
      adapter = { setAccount: mockAdapterSetAccount }
      indexManager = {
        listAutomergeItemIds: mockIndexManagerListAutomergeItemIds,
        addAutomergeItemIdsToIndex: mockIndexManagerAddAutomergeItemIdsToIndex,
        removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
      }
      itemOperations = {
        mutateItem: mockItemOperationsMutateItem,
      }
      snapshotManager = {
        onOnlineStateChange: mockSnapshotManagerOnOnlineStateChange,
        markItemDirty: vi.fn(),
        recordInboundChange: vi.fn(),
        flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 0, total: 0 }),
        exportLastModified: vi.fn().mockReturnValue({}),
        importLastModified: vi.fn().mockResolvedValue(undefined),
      }
      orchestrator = {
        setOnlineState: mockOrchestratorSetOnlineState,
        flush: mockOrchestratorFlush,
        shutdown: vi.fn().mockResolvedValue(undefined),
      }
      pullQueueManager = {
        onKeyringUpdated: vi.fn(),
        exportCursors: vi.fn().mockReturnValue([]),
        importCursors: vi.fn(),
      }
      manifestSyncManager = {
        sync: vi.fn().mockResolvedValue(undefined),
      }
      docStore = {
        onDocHandleReplaced: mockDocStoreOnDocHandleReplaced,
        exportAllBinaries: vi.fn().mockResolvedValue({}),
        restoreFromBinaries: vi.fn().mockResolvedValue([]),
      }
      recoveryManager = {
        unquarantineBatch: mockRecoveryManagerUnquarantineBatch,
        listRecoveryItems: mockRecoveryManagerListRecoveryItems,
        unquarantine: vi.fn().mockResolvedValue(undefined),
        dismissEntry: vi.fn().mockResolvedValue(undefined),
      }
      wal = {
        readAll: vi.fn().mockResolvedValue(new Map()),
        append: vi.fn().mockResolvedValue(undefined),
      }

      initialize = mockContextInitialize
      shutdown = mockContextShutdown
      claimLeader = mockContextClaimLeader
      retrySave = mockContextRetrySave

      constructor(config?: any) {
        if (config?.onDocHandleReplaced) {
          this.docStore.onDocHandleReplaced = config.onDocHandleReplaced
        }
      }
    }
  }
})

const { mockRepoFind } = vi.hoisted(() => ({
  mockRepoFind: vi.fn().mockImplementation(() => Promise.resolve({
    on: vi.fn(),
    off: vi.fn(),
    doc: vi.fn().mockReturnValue({ id: 'item-1', name: 'Original Item' }),
    documentId: 'mock-doc-id',
  }))
}))

vi.mock('./utils/automerge', () => ({
  toAutomergeUrlFromItemId: vi.fn().mockReturnValue('automerge:item-1'),
  ACCOUNT_INDEX_DOCUMENT_ID: '__account_index__',
}))

describe('SyncWorker initRepo cleanup on re-init', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIndexManagerListAutomergeItemIds.mockResolvedValue([])
    mockBrokerSetAccount.mockResolvedValue(undefined)
    mockContextInitialize.mockResolvedValue(undefined)
    mockContextShutdown.mockResolvedValue(undefined)
  })

  it('shuts down previous context when initRepo is called a second time', async () => {
    const worker = new SyncWorker()

    // First init
    await worker.initRepo('account-1', 'vault-key-1')
    expect(mockContextShutdown).not.toHaveBeenCalled()

    // Second init (e.g. account switch)
    await worker.initRepo('account-2', 'vault-key-2')
    expect(mockContextShutdown).toHaveBeenCalledTimes(1)
  })

  it('awaits broker.setAccount before calling adapter.setAccount during initRepo', async () => {
    const callOrder: string[] = []
    let brokerFinished = false

    mockBrokerSetAccount.mockImplementation(async () => {
      callOrder.push('broker.setAccount:start')
      await new Promise(resolve => setTimeout(resolve, 5))
      brokerFinished = true
      callOrder.push('broker.setAccount:end')
    })

    mockAdapterSetAccount.mockImplementation(() => {
      callOrder.push(`adapter.setAccount:brokerFinished=${brokerFinished}`)
    })

    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    expect(mockBrokerSetAccount).toHaveBeenCalledWith('account-1')
    expect(mockAdapterSetAccount).toHaveBeenCalledWith('account-1')
    expect(callOrder).toEqual([
      'broker.setAccount:start',
      'broker.setAccount:end',
      'adapter.setAccount:brokerFinished=true',
    ])
  })

  it('shuts down context and clears listeners on shutdown', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    await worker.shutdown()

    expect(mockContextShutdown).toHaveBeenCalledTimes(1)
    expect(() => (worker as any).context).toThrow('SyncWorker not initialized')
  })

  it('delegates initialize to SyncWorkerContext.initialize', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')
    expect(mockContextInitialize).toHaveBeenCalledTimes(1)
  })

  it('pauses BroadcastChannel sync via context.repoManager on multipleLeadersDetected', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    // Fire the internal event subscription
    ;(worker as any).internalEventHub.emit({ type: 'multipleLeadersDetected' })
    expect(mockRepoManagerPauseBroadcastSync).toHaveBeenCalledTimes(1)
  })

  it('resumes BroadcastChannel sync via context.repoManager on soleLeaderRestored', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    ;(worker as any).internalEventHub.emit({ type: 'soleLeaderRestored' })
    expect(mockRepoManagerResumeBroadcastSync).toHaveBeenCalledTimes(1)
  })
})

describe('SyncWorker onDocHandleReplaced / change listener rebinding', () => {
  it('rebinds change listener from old handle to new handle when onDocHandleReplaced is called', async () => {
    const handleAChangeListeners: Array<() => void> = []
    const handleA = {
      documentId: 'doc-item-1',
      on: vi.fn().mockImplementation((event: string, fn: () => void) => {
        if (event === 'change') handleAChangeListeners.push(fn)
      }),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({ id: 'item-1', name: 'Original Item' }),
    }

    mockRepoFind.mockResolvedValue(handleA)

    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    const clientEvents: any[] = []
    ;(worker as any).clientEventHub.subscribe((evt: any) => {
      clientEvents.push(evt)
    })

    // Subscribe to item-1
    worker.subscribeToItems(['item-1' as any])
    await Promise.resolve()

    expect(handleA.on).toHaveBeenCalledWith('change', expect.any(Function))
    expect(clientEvents).toContainEqual({
      type: 'itemUpdated',
      id: 'item-1',
      item: expect.objectContaining({ id: 'item-1', name: 'Original Item' }),
    })

    // Now document handle is replaced (e.g. via seedImportedDocument or compactDocument)
    const handleBChangeListeners: Array<() => void> = []
    const handleB = {
      documentId: 'doc-item-1',
      on: vi.fn().mockImplementation((event: string, fn: () => void) => {
        if (event === 'change') handleBChangeListeners.push(fn)
      }),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({ id: 'item-1', name: 'Compacted / Seeded Item' }),
    }

    clientEvents.length = 0

    // Invoke the onDocHandleReplaced callback wired by SyncWorker into SyncWorkerContext config
    ;(worker as any)._context.docStore.onDocHandleReplaced('item-1' as any, handleB)

    // 1. Old handle listener must be unbound
    expect(handleA.off).toHaveBeenCalledWith('change', expect.any(Function))

    // 2. New handle listener must be bound
    expect(handleB.on).toHaveBeenCalledWith('change', expect.any(Function))

    // 3. Immediate snapshot must be emitted for the new handle
    expect(clientEvents).toContainEqual({
      type: 'itemUpdated',
      id: 'item-1',
      item: expect.objectContaining({ id: 'item-1', name: 'Compacted / Seeded Item' }),
    })

    // 4. Subsequent changes on handleB must trigger the listener and emit itemUpdated
    clientEvents.length = 0
    handleB.doc.mockReturnValue({ id: 'item-1', name: 'Subsequent Edit on New Handle' })
    handleBChangeListeners[0]()

    expect(clientEvents).toContainEqual({
      type: 'itemUpdated',
      id: 'item-1',
      item: expect.objectContaining({ id: 'item-1', name: 'Subsequent Edit on New Handle' }),
    })
  })

  it('does not bind listener when onDocHandleReplaced is called for an unsubscribed item', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    const handle = {
      documentId: 'doc-item-unsub',
      on: vi.fn(),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({ id: 'item-unsub', name: 'Unsubscribed Item' }),
    }

    ;(worker as any)._context.docStore.onDocHandleReplaced('item-unsub' as any, handle)

    expect(handle.on).not.toHaveBeenCalled()
  })

  it('delegates claimLeader to context.claimLeader', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    await worker.claimLeader()
    expect(mockContextClaimLeader).toHaveBeenCalledTimes(1)
  })
})

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SyncWorker readiness and queueing before initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIndexManagerListAutomergeItemIds.mockResolvedValue([])
    mockBrokerSetAccount.mockResolvedValue(undefined)
    mockContextInitialize.mockResolvedValue(undefined)
    mockContextShutdown.mockResolvedValue(undefined)
    mockItemOperationsMutateItem.mockResolvedValue(undefined)
    mockRecoveryManagerListRecoveryItems.mockResolvedValue([{ entryId: 'rec-1' }] as any)
  })

  it('queues API calls made while initRepo is in-flight and resolves them once init completes', async () => {
    const initDeferred = createDeferred<void>()
    mockContextInitialize.mockImplementation(() => initDeferred.promise)

    const worker = new SyncWorker()
    // Start initRepo without awaiting it yet
    const initPromise = worker.initRepo('account-1', 'vault-key-1')

    // Fire API calls while init is in-flight
    let mutateDone = false
    const mutatePromise = worker.mutateItem('item-1' as any, { name: 'Updated' }).then(() => {
      mutateDone = true
    })

    let recoveryItemsResult: any = null
    const recoveryPromise = worker.listRecoveryItems().then(items => {
      recoveryItemsResult = items
    })

    // Give microtasks a tick
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(mutateDone).toBe(false)
    expect(recoveryItemsResult).toBeNull()
    expect(mockItemOperationsMutateItem).not.toHaveBeenCalled()

    // Complete initRepo
    initDeferred.resolve()
    await initPromise
    await mutatePromise
    await recoveryPromise

    expect(mutateDone).toBe(true)
    expect(mockItemOperationsMutateItem).toHaveBeenCalledWith('item-1', { name: 'Updated' })
    expect(recoveryItemsResult).toEqual([{ entryId: 'rec-1' }])
  })

  it('queues API calls made before initRepo is even invoked', async () => {
    const worker = new SyncWorker()

    // Fire API call before initRepo is called
    let mutateDone = false
    const mutatePromise = worker.mutateItem('item-pre' as any, { name: 'PreInit' }).then(() => {
      mutateDone = true
    })

    await Promise.resolve()
    expect(mutateDone).toBe(false)
    expect(mockItemOperationsMutateItem).not.toHaveBeenCalled()

    // Now start and finish initRepo
    await worker.initRepo('account-1', 'vault-key-1')
    await mutatePromise

    expect(mutateDone).toBe(true)
    expect(mockItemOperationsMutateItem).toHaveBeenCalledWith('item-pre', { name: 'PreInit' })
  })

  it('queues setOnlineState while initRepo is in-flight and updates online state after ready', async () => {
    const initDeferred = createDeferred<void>()
    mockContextInitialize.mockImplementation(() => initDeferred.promise)

    const worker = new SyncWorker()
    const initPromise = worker.initRepo('account-1', 'vault-key-1')

    const onlinePromise = worker.setOnlineState(false)

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(mockOrchestratorSetOnlineState).not.toHaveBeenCalled()

    initDeferred.resolve()
    await initPromise
    await onlinePromise

    expect(mockOrchestratorSetOnlineState).toHaveBeenCalledWith(false)
  })

  it('rejects queued API calls if initRepo fails', async () => {
    const initDeferred = createDeferred<void>()
    mockContextInitialize.mockImplementation(() => initDeferred.promise)

    const worker = new SyncWorker()
    const initPromise = worker.initRepo('account-1', 'vault-key-1')

    const mutatePromise = worker.mutateItem('item-1' as any, { name: 'Fail' })

    await new Promise(resolve => setTimeout(resolve, 5))
    initDeferred.reject(new Error('WASM initialization failed'))

    await expect(initPromise).rejects.toThrow('WASM initialization failed')
    await expect(mutatePromise).rejects.toThrow('WASM initialization failed')
  })

  it('rejects API calls invoked after shutdown', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')
    await worker.shutdown()

    await expect(worker.mutateItem('item-1' as any, {})).rejects.toThrow(
      'SyncWorker not initialized. Call initRepo first.'
    )
  })

  it('queues API calls during second initRepo (account switch) until new context is ready', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    // Second init begins with delayed initialization
    const secondInitDeferred = createDeferred<void>()
    mockContextInitialize.mockImplementation(() => secondInitDeferred.promise)

    const secondInitPromise = worker.initRepo('account-2', 'vault-key-2')

    let mutateDone = false
    const mutatePromise = worker.mutateItem('item-switch' as any, { name: 'Switch' }).then(() => {
      mutateDone = true
    })

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(mutateDone).toBe(false)

    secondInitDeferred.resolve()
    await secondInitPromise
    await mutatePromise

    expect(mutateDone).toBe(true)
    expect(mockItemOperationsMutateItem).toHaveBeenCalledWith('item-switch', { name: 'Switch' })
  })
})
