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

vi.mock('./docStore', () => ({
  AutomergeDocStore: class MockDocStore {
    initialize = vi.fn().mockResolvedValue(undefined)
    withAutomergeDocumentChange = vi.fn().mockResolvedValue(true)
    removeAutomergeItem = vi.fn().mockResolvedValue(undefined)
    getAutomergeItem = vi.fn().mockResolvedValue(null)
    clear = vi.fn().mockResolvedValue(undefined)
    normalizeItemSnapshot = vi.fn()
    shutdown = vi.fn().mockResolvedValue(undefined)
  },
  normalizeItemSnapshot: vi.fn().mockImplementation((id, doc) => ({ ...doc, id }))
}))

vi.mock('./docStore/AutomergeIndexManager', () => ({
  AutomergeIndexManager: class MockIndexManager {
    listAutomergeItemIds = vi.fn().mockResolvedValue([])
    addAutomergeItemIdsToIndex = vi.fn().mockResolvedValue(undefined)
    removeAutomergeItemIdsFromIndex = vi.fn().mockResolvedValue(undefined)
    getAutomergeMetadata = vi.fn().mockResolvedValue({})
    ensureIndexDocument = vi.fn().mockResolvedValue(undefined)
  }
}))

vi.mock('../../api/vault', () => ({
  initWorkerVault: vi.fn().mockResolvedValue(undefined),
}))

const { mockRepoFind } = vi.hoisted(() => ({
  mockRepoFind: vi.fn().mockImplementation(() => Promise.resolve({
    on: vi.fn(),
    off: vi.fn(),
    doc: vi.fn().mockReturnValue({ id: 'item-1', name: 'Original Item' }),
    documentId: 'mock-doc-id',
  }))
}))

vi.mock('./AutomergeRepoManager', () => {
  const mockRepo = {
    find: mockRepoFind,
    handles: {},
  }
  return {
    AutomergeRepoManager: class MockRepoManager {
      init = vi.fn().mockReturnValue(mockRepo)
      getRepo = vi.fn().mockReturnValue(mockRepo)
      close = vi.fn().mockResolvedValue(undefined)
    },
    getAutomergeDBName: vi.fn().mockReturnValue('mock-db'),
  }
})

vi.mock('./utils/automerge', () => ({
  toAutomergeUrlFromItemId: vi.fn().mockReturnValue('automerge:item-1'),
}))

const mockAdapterDisconnect = vi.fn()
const mockAdapterSetAccount = vi.fn()
vi.mock('./VaultEncryptedNetworkAdapter', () => {
  return {
    VaultNetworkAdapter: class MockAdapter {
      setAccount = mockAdapterSetAccount
      setSendEnabled = vi.fn()
      disconnect = mockAdapterDisconnect
    }
  }
})

const mockBrokerShutdown = vi.fn().mockResolvedValue(undefined)
const mockBrokerSetAccount = vi.fn().mockResolvedValue(undefined)
vi.mock('./SyncMessageBroker', () => {
  return {
    SyncMessageBroker: class MockBroker {
      setOnlineState = vi.fn()
      setAccount = mockBrokerSetAccount
      setSendEnabled = vi.fn()
      shutdown = mockBrokerShutdown
      flush = vi.fn()
      exportCursors = vi.fn().mockReturnValue([])
      importCursors = vi.fn()
      executePoll = vi.fn().mockResolvedValue('success')
      hasPendingPulls = vi.fn().mockReturnValue(false)
      queuePendingPullItems = vi.fn()
      onFlushNeeded?: () => void
    }
  }
})

describe('SyncWorker initRepo cleanup on re-init', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shuts down broker and disconnects adapter when initRepo is called a second time', async () => {
    const worker = new SyncWorker()

    // First init
    await worker.initRepo('account-1', 'vault-key-1')
    expect(mockBrokerShutdown).not.toHaveBeenCalled()
    expect(mockAdapterDisconnect).not.toHaveBeenCalled()

    // Second init (e.g. account switch)
    await worker.initRepo('account-2', 'vault-key-2')
    expect(mockBrokerShutdown).toHaveBeenCalledTimes(1)
    expect(mockAdapterDisconnect).toHaveBeenCalledTimes(1)
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

    // Invoke docStore's onDocHandleReplaced callback
    ;(worker as any).context.docStore.onDocHandleReplaced('item-1' as any, handleB)

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

    ;(worker as any).context.docStore.onDocHandleReplaced('item-unsub' as any, handle)

    expect(handle.on).not.toHaveBeenCalled()
  })

  it('delegates claimLeader to context.claimLeader', async () => {
    const worker = new SyncWorker()
    await worker.initRepo('account-1', 'vault-key-1')

    const claimSpy = vi.spyOn((worker as any).context, 'claimLeader').mockImplementation(() => {})
    await worker.claimLeader()
    expect(claimSpy).toHaveBeenCalledTimes(1)
  })
})

