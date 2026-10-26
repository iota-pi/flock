import { SyncWorker, exposeSyncWorker, type SyncWorkerConfig } from './sync.worker'
import { getVaultStorageNames } from '../shared/storageNames'
import { getApiAuthToken } from '../../api/runtime'
import type { ItemId } from '@vault/shared'

const { realtimeListeners } = vi.hoisted(() => ({
  realtimeListeners: [] as Array<(itemIds: string[]) => void>,
}))

vi.mock('./realtimeBus', () => ({
  subscribeRealtimeBusSyncPing: vi.fn((_accountId: string, listener: (itemIds: string[]) => void) => {
    realtimeListeners.push(listener)
    return () => {}
  }),
  publishRealtimeBusSyncPing: vi.fn(),
  teardownRealtimeBus: vi.fn(),
}))

vi.mock('comlink', async importOriginal => ({
  ...await importOriginal<typeof import('comlink')>(),
  expose: vi.fn(),
}))

// Mock Automerge WASM
vi.mock('@automerge/automerge/slim', () => ({
  initializeWasm: vi.fn().mockResolvedValue(undefined),
  save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
  from: vi.fn(),
}))

vi.mock('../../api/Keyring', () => ({
  Keyring: class {
    load = vi.fn().mockResolvedValue(undefined)
  },
}))

vi.mock('./docStore', () => ({
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
const mockRecoveryManagerResolveQuarantines = vi.fn().mockResolvedValue(undefined)
const mockRecoveryManagerUnquarantine = vi.fn().mockResolvedValue(undefined)
const mockItemOperationsMutateItem = vi.fn().mockResolvedValue(undefined)
const mockRecoveryManagerListRecoveryItems = vi.fn().mockResolvedValue([])
const mockOrchestratorSetOnlineState = vi.fn()
const mockOrchestratorFlush = vi.fn()
const mockSnapshotManagerOnOnlineStateChange = vi.fn()
const mockAccountSettingsHandleSettingsDoc = vi.fn()

const { mockRepoFind } = vi.hoisted(() => ({
  mockRepoFind: vi.fn().mockImplementation(() => Promise.resolve({
    on: vi.fn(),
    off: vi.fn(),
    doc: vi.fn().mockReturnValue({ id: 'item-1', name: 'Original Item' }),
    documentId: 'mock-doc-id',
  }))
}))

vi.mock('./SyncWorkerContext', () => {
  return {
    SyncWorkerContext: class MockSyncWorkerContext {
      // Public properties accessed by SyncWorker
      accountId = 'test-account'
      services = {
        repo: { find: mockRepoFind, handles: {} },
        repoManager: {
          pauseBroadcastSync: mockRepoManagerPauseBroadcastSync,
          resumeBroadcastSync: mockRepoManagerResumeBroadcastSync,
        },
        broker: {
          setAccount: mockBrokerSetAccount,
        },
        adapter: { setAccount: mockAdapterSetAccount },
        indexManager: {
          listAutomergeItemIds: mockIndexManagerListAutomergeItemIds,
          addAutomergeItemIdsToIndex: mockIndexManagerAddAutomergeItemIdsToIndex,
          removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
        },
        accountSettings: {
          isSettingsDoc: (id: string) => id === 'settings-test-account',
          handleSettingsDoc: mockAccountSettingsHandleSettingsDoc,
          mutate: vi.fn().mockResolvedValue(undefined),
        },
        itemOperations: {
          mutateItem: mockItemOperationsMutateItem,
          recreateOversizedItem: vi.fn().mockResolvedValue('item-new'),
        },
        snapshotManager: {
          onOnlineStateChange: mockSnapshotManagerOnOnlineStateChange,
          markItemDirty: vi.fn(),
          flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 0, total: 0 }),
          exportLastModified: vi.fn().mockReturnValue({}),
          importLastModified: vi.fn().mockResolvedValue(undefined),
          clearOversized: vi.fn(),
        },
        orchestrator: {
          setOnlineState: mockOrchestratorSetOnlineState,
          flush: mockOrchestratorFlush,
          shutdown: vi.fn().mockResolvedValue(undefined),
        },
        pullQueueManager: {
          onKeyringUpdated: vi.fn(),
          exportCursors: vi.fn().mockReturnValue([]),
          importCursors: vi.fn(),
        },
        manifestSyncManager: {
          sync: vi.fn().mockResolvedValue(undefined),
        },
        docStore: {
          // SyncWorker.bindItemHandle decodes through the doc store; return a clean item shape
          decodeSnapshot: vi.fn().mockImplementation((id: string, doc: unknown) => (doc ? ({ ...(doc as object), id }) : null)),
          exportAllBinaries: vi.fn().mockResolvedValue({}),
          restoreFromBinaries: vi.fn().mockResolvedValue([]),
        },
        recoveryManager: {
          resolveQuarantines: mockRecoveryManagerResolveQuarantines,
          listRecoveryItems: mockRecoveryManagerListRecoveryItems,
          unquarantine: mockRecoveryManagerUnquarantine,
          dismissEntry: vi.fn().mockResolvedValue(undefined),
        },
        wal: {
          readAll: vi.fn().mockResolvedValue(new Map()),
          append: vi.fn().mockResolvedValue(undefined),
        },
        itemReencryptor: {
          reencryptAllItems: vi.fn().mockResolvedValue({ succeeded: [], failed: [] }),
        },
      }

      apiClient = {}

      initialize = mockContextInitialize
      shutdown = mockContextShutdown
      claimLeader = mockContextClaimLeader
      retrySave = mockContextRetrySave
      rewrapDeviceKey = vi.fn().mockResolvedValue(undefined)
    }
  }
})

vi.mock('./utils/automerge', () => ({
  toAutomergeUrlFromItemId: vi.fn().mockReturnValue('automerge:item-1'),
  isIndexDocument: (id: string) => id === '__account_index__',
}))

const workerConfig: SyncWorkerConfig = {
  automergeWasmUrl: 'mock-wasm-url',
  endpoint: '',
  storageNames: getVaultStorageNames(),
}

describe('SyncWorker initRepo cleanup on re-init', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIndexManagerListAutomergeItemIds.mockResolvedValue([])
    mockBrokerSetAccount.mockResolvedValue(undefined)
    mockContextInitialize.mockResolvedValue(undefined)
    mockContextShutdown.mockResolvedValue(undefined)
  })

  it('shuts down previous context when initRepo is called a second time', async () => {
    const worker = new SyncWorker(workerConfig)

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

    const worker = new SyncWorker(workerConfig)
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
    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')

    await worker.shutdown()

    expect(mockContextShutdown).toHaveBeenCalledTimes(1)
    expect(() => (worker as any).context).toThrow('SyncWorker not initialized')
  })

  it('delegates initialize to SyncWorkerContext.initialize', async () => {
    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')
    expect(mockContextInitialize).toHaveBeenCalledTimes(1)
  })

  it('pauses BroadcastChannel sync via context.services.repoManager on multipleLeadersDetected', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')

    // Fire the internal event subscription
    ;(worker as any).internalEventHub.emit({ type: 'multipleLeadersDetected' })
    expect(mockRepoManagerPauseBroadcastSync).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[SyncWorker] Multiple leaders detected. Pausing BroadcastChannel sync to prevent feedback loop.'
    )
    warnSpy.mockRestore()
  })

  it('resumes BroadcastChannel sync via context.services.repoManager on soleLeaderRestored', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')

    ;(worker as any).internalEventHub.emit({ type: 'soleLeaderRestored' })
    expect(mockRepoManagerResumeBroadcastSync).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledWith(
      '[SyncWorker] Sole leader restored. Resuming BroadcastChannel sync.'
    )
    infoSpy.mockRestore()
  })
})

describe('SyncWorker docHandleReplaced / change listener rebinding', () => {
  it('rebinds change listener from old handle to new handle when docHandleReplaced is emitted', async () => {
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

    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')

    const clientEvents: any[] = []
    ;(worker as any).clientEventHub.subscribe((evt: any) => {
      clientEvents.push(evt)
    })

    // Subscribe to item-1
    ;(worker as any).subscriptions.subscribe(['item-1' as any])
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

    ;(worker as any).internalEventHub.emit({ type: 'docHandleReplaced', itemId: 'item-1', handle: handleB })

    // 1. Old handle listener must be unbound with the exact registered reference
    const registeredListenerA = (handleA.on as any).mock.calls[0][1]
    expect(handleA.off).toHaveBeenCalledWith('change', registeredListenerA)

    // 2. New handle listener must be bound
    expect(handleB.on).toHaveBeenCalledWith('change', expect.any(Function))

    // 3. Exactly one immediate snapshot must be emitted for the new handle
    expect(handleB.on).toHaveBeenCalledTimes(1)
    expect(clientEvents.filter(evt => evt.type === 'itemUpdated')).toEqual([{
      type: 'itemUpdated',
      id: 'item-1',
      item: expect.objectContaining({ id: 'item-1', name: 'Compacted / Seeded Item' }),
    }])

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

  it('does not bind listener when docHandleReplaced is emitted for an unsubscribed item', async () => {
    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')

    const handle = {
      documentId: 'doc-item-unsub',
      on: vi.fn(),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({ id: 'item-unsub', name: 'Unsubscribed Item' }),
    }

    ;(worker as any).internalEventHub.emit({ type: 'docHandleReplaced', itemId: 'item-unsub', handle })

    expect(handle.on).not.toHaveBeenCalled()
  })

  it('routes settings document changes to accountSettings instead of the item stream', async () => {
    const handle = {
      documentId: 'doc-settings',
      on: vi.fn(),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({ prayerGoal: 4 }),
    }
    mockRepoFind.mockResolvedValue(handle)
    mockAccountSettingsHandleSettingsDoc.mockClear()
    mockIndexManagerAddAutomergeItemIdsToIndex.mockClear()

    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')
    const clientEvents: any[] = []
    ;(worker as any).clientEventHub.subscribe((evt: any) => clientEvents.push(evt))

    ;(worker as any).subscriptions.subscribe(['settings-test-account' as any])
    await Promise.resolve()

    expect(mockAccountSettingsHandleSettingsDoc).toHaveBeenCalledWith({ prayerGoal: 4 })
    expect(clientEvents.filter(evt => evt.type === 'itemUpdated')).toEqual([])
    expect(mockIndexManagerAddAutomergeItemIdsToIndex).not.toHaveBeenCalled()
  })

  it('keeps the settings document out of the initial index sent to the app but still subscribes to it', async () => {
    const handle = { documentId: 'doc', on: vi.fn(), off: vi.fn(), doc: vi.fn().mockReturnValue(null) }
    mockRepoFind.mockResolvedValue(handle)
    mockIndexManagerListAutomergeItemIds.mockResolvedValueOnce(['item-1', 'settings-test-account'])

    const worker = new SyncWorker(workerConfig)
    const clientEvents: any[] = []
    ;(worker as any).clientEventHub.subscribe((evt: any) => clientEvents.push(evt))
    const originalInitState = (worker as any).initWorkerState.bind(worker)
    ;(worker as any).initWorkerState = () => {
      originalInitState()
      ;(worker as any).clientEventHub.subscribe((evt: any) => clientEvents.push(evt))
    }
    await worker.initRepo('account-1', 'vault-key-1')

    expect(clientEvents).toContainEqual({ type: 'indexUpdated', itemIds: ['item-1'] })
    expect((worker as any).subscriptions.has('settings-test-account')).toBe(true)
  })

  it('unsubscribes and detaches the exact registered listener reference when an item is deleted', async () => {
    let changeCallback: (() => void) | undefined
    const handle = {
      documentId: 'doc-item-3',
      on: vi.fn().mockImplementation((event: string, fn: () => void) => {
        if (event === 'change') changeCallback = fn
      }),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({ id: 'item-3', name: 'Item 3' }),
    }
    mockRepoFind.mockResolvedValue(handle)

    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')

    ;(worker as any).subscriptions.subscribe(['item-3' as any])
    await Promise.resolve()

    expect(handle.on).toHaveBeenCalledWith('change', expect.any(Function))
    const registeredListener = (handle.on as any).mock.calls[0][1]

    handle.doc.mockReturnValue({ id: 'item-3', name: 'Item 3', deleted: true })
    changeCallback?.()

    expect(handle.off).toHaveBeenCalledWith('change', registeredListener)
  })

  it('detaches the exact registered listener reference for all handles on shutdown', async () => {
    const handle = {
      documentId: 'doc-item-4',
      on: vi.fn(),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({ id: 'item-4', name: 'Item 4' }),
    }
    mockRepoFind.mockResolvedValue(handle)

    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')

    ;(worker as any).subscriptions.subscribe(['item-4' as any])
    await Promise.resolve()

    const registeredListener = (handle.on as any).mock.calls[0][1]

    await worker.shutdown()

    expect(handle.off).toHaveBeenCalledWith('change', registeredListener)
  })

  it('delegates claimLeader to context.claimLeader', async () => {
    const worker = new SyncWorker(workerConfig)
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

describe('SyncWorker quota status', () => {
  it('updates quota status once per quotaExceeded / quotaResolved client event', async () => {
    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')
    const setQuotaExceeded = vi.spyOn((worker as any).syncStatusManager, 'setQuotaExceeded')

    ;(worker as any).clientEventHub.emit({ type: 'quotaExceeded', message: 'Storage limit reached' })
    expect(setQuotaExceeded.mock.calls).toEqual([[true]])

    ;(worker as any).clientEventHub.emit({ type: 'quotaResolved' })
    expect(setQuotaExceeded.mock.calls).toEqual([[true], [false]])
  })
})

describe('SyncWorker shutdown during initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIndexManagerListAutomergeItemIds.mockResolvedValue([])
    mockBrokerSetAccount.mockResolvedValue(undefined)
    mockContextShutdown.mockResolvedValue(undefined)
  })

  it('stops initRepo rather than starting the account session after a shutdown', async () => {
    const initDeferred = createDeferred<void>()
    mockContextInitialize.mockImplementation(() => initDeferred.promise)

    const worker = new SyncWorker(workerConfig)
    const initPromise = worker.initRepo('account-1', 'vault-key-1')
    await new Promise(resolve => setTimeout(resolve, 5))

    const shutdownPromise = worker.shutdown()
    initDeferred.resolve()

    await expect(initPromise).rejects.toThrow('shut down during initialization')
    await shutdownPromise
    expect(mockBrokerSetAccount).not.toHaveBeenCalled()
    expect(mockAdapterSetAccount).not.toHaveBeenCalled()
  })

  it("doesn't leave an unhandled rejection when initRepo fails with nothing waiting", async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    mockContextInitialize.mockRejectedValueOnce(new Error('Init failed'))
    try {
      const worker = new SyncWorker(workerConfig)
      await expect(worker.initRepo('account-1', 'vault-key-1')).rejects.toThrow('Init failed')
      await worker.shutdown()
      await new Promise(resolve => setTimeout(resolve, 10))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})

describe('worker error reporting', () => {
  const dispatchError = () => {
    const event = new ErrorEvent('error', { message: 'Uncaught in a timer', cancelable: true })
    self.dispatchEvent(event)
    return event
  }

  beforeAll(() => {
    exposeSyncWorker(workerConfig)
  })

  it("lets an error reach the main thread while there's no event port to report it on", () => {
    expect(dispatchError().defaultPrevented).toBe(false)
  })

  it('reports an uncaught error and cancels it, so the main thread does not treat it as a crash', () => {
    const port = { postMessage: vi.fn() }
    self.dispatchEvent(new MessageEvent('message', { data: { type: 'EVENT_PORT', port } }))

    const event = dispatchError()

    expect(port.postMessage).toHaveBeenCalledWith({
      type: 'workerError',
      error: expect.objectContaining({ message: 'Uncaught in a timer' }),
    })
    expect(event.defaultPrevented).toBe(true)
  })
})

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

    const worker = new SyncWorker(workerConfig)
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
    const worker = new SyncWorker(workerConfig)

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

    const worker = new SyncWorker(workerConfig)
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

    const worker = new SyncWorker(workerConfig)
    const initPromise = worker.initRepo('account-1', 'vault-key-1')

    const mutatePromise = worker.mutateItem('item-1' as any, { name: 'Fail' })

    await new Promise(resolve => setTimeout(resolve, 5))
    initDeferred.reject(new Error('WASM initialization failed'))

    await expect(initPromise).rejects.toThrow('WASM initialization failed')
    await expect(mutatePromise).rejects.toThrow('WASM initialization failed')
  })

  it('rejects API calls invoked after shutdown', async () => {
    const worker = new SyncWorker(workerConfig)
    await worker.initRepo('account-1', 'vault-key-1')
    await worker.shutdown()

    await expect(worker.mutateItem('item-1' as any, {})).rejects.toThrow(
      'SyncWorker not initialized. Call initRepo first.'
    )
  })

  it('queues API calls during second initRepo (account switch) until new context is ready', async () => {
    const worker = new SyncWorker(workerConfig)
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

  describe('Auth token refresh and progress events without Comlink proxies', () => {
    it('emits tokenRefreshNeeded and resolves when updateAuthToken is called', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')

      const eventSpy = vi.fn()
      ;(worker as any).clientEventHub.subscribe(eventSpy)

      // Start token refresh request
      const refreshPromise = worker.requestAuthTokenRefresh()
      expect(eventSpy).toHaveBeenCalledWith({ type: 'tokenRefreshNeeded' })

      // Call updateAuthToken to supply refreshed token
      await worker.updateAuthToken('new-session-token-xyz')
      const token = await refreshPromise

      expect(token).toBe('new-session-token-xyz')
      expect(getApiAuthToken()).toBe('new-session-token-xyz')
    })

    it('shares one main-thread round trip between concurrent refresh requests', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')

      const eventSpy = vi.fn()
      ;(worker as any).clientEventHub.subscribe(eventSpy)

      const first = worker.requestAuthTokenRefresh()
      const second = worker.requestAuthTokenRefresh()
      await worker.updateAuthToken('shared-token')

      expect(await first).toBe('shared-token')
      expect(await second).toBe('shared-token')
      expect(eventSpy.mock.calls.filter(([event]) => event.type === 'tokenRefreshNeeded')).toHaveLength(1)
    })

    it('forgets the session token at shutdown', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1', { authToken: 'session-token' })
      expect(getApiAuthToken()).toBe('session-token')

      await worker.shutdown()

      expect(getApiAuthToken()).toBe('')
    })

    it('emits reencryptProgress event during reencryptAllItems', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')

      const eventSpy = vi.fn()
      ;(worker as any).clientEventHub.subscribe(eventSpy)

      // Mock itemReencryptor.reencryptAllItems to invoke the onProgress callback it receives
      ;(worker as any)._context.services.itemReencryptor.reencryptAllItems.mockImplementationOnce(
        async (_deps: any, onProgress: (done: number, total: number) => void) => {
          onProgress(3, 10)
          onProgress(10, 10)
          return { succeeded: ['item-1'], failed: [] }
        }
      )

      await worker.reencryptAllItems()

      expect(eventSpy).toHaveBeenCalledWith({ type: 'reencryptProgress', done: 3, total: 10 })
      expect(eventSpy).toHaveBeenCalledWith({ type: 'reencryptProgress', done: 10, total: 10 })
    })

    it('re-wraps the device storage key once every item has been re-encrypted', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')
      const ctx = (worker as any)._context
      const order: string[] = []
      ctx.services.itemReencryptor.reencryptAllItems.mockImplementationOnce(async () => {
        order.push('items')
        return { succeeded: [], failed: [] }
      })
      ctx.rewrapDeviceKey.mockImplementationOnce(async () => {
        order.push('rewrap')
      })

      await worker.reencryptAllItems()

      expect(order).toEqual(['items', 'rewrap'])
    })

    it('does not touch manual recovery entries when a realtime bus ping arrives', async () => {
      realtimeListeners.length = 0
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')
      expect(realtimeListeners.length).toBeGreaterThan(0)

      realtimeListeners[realtimeListeners.length - 1](['item-1'])

      const ctx = (worker as any)._context
      // Pings can name deleted items, so they must not take IDs out of the tombstones
      expect(ctx.services.indexManager.addAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-1'], { skipTombstoned: true })
      expect(mockRecoveryManagerResolveQuarantines).not.toHaveBeenCalled()
      expect(mockRecoveryManagerUnquarantine).not.toHaveBeenCalled()
    })

    it('clears the oversized flag, unquarantines and re-marks the item dirty on retryRecoveryItem', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')

      await worker.retryRecoveryItem('item-1' as ItemId)

      const ctx = (worker as any)._context
      expect(mockRecoveryManagerUnquarantine).toHaveBeenCalledWith('item-1')
      expect(ctx.services.snapshotManager.clearOversized).toHaveBeenCalledWith('item-1')
      expect(ctx.services.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-1')
    })

    it('delegates recreateOversizedItem to itemOperations and flushes snapshots', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')

      const newItemId = await worker.recreateOversizedItem('item-old' as ItemId)

      expect(newItemId).toBe('item-new')
      expect((worker as any)._context.services.itemOperations.recreateOversizedItem).toHaveBeenCalledWith('item-old')
      expect((worker as any)._context.services.snapshotManager.clearOversized).toHaveBeenCalledWith('item-old')
      expect((worker as any)._context.services.snapshotManager.flushPendingSnapshots).toHaveBeenCalled()
    })

    it('delegates flushSync to orchestrator.flush and returns a Promise<void>', async () => {
      const worker = new SyncWorker(workerConfig)
      await worker.initRepo('account-1', 'vault-key-1')

      const result = worker.flushSync()
      expect(result).toBeInstanceOf(Promise)
      await result

      expect(mockOrchestratorFlush).toHaveBeenCalledTimes(1)
    })
  })
})
