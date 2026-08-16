import { describe, it, expect, vi, beforeEach } from 'vitest'
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

vi.mock('./AutomergeRepoManager', () => {
  const mockRepo = {
    find: vi.fn().mockResolvedValue({
      on: vi.fn(),
      off: vi.fn(),
      doc: vi.fn().mockReturnValue({}),
    }),
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
vi.mock('./VaultEncryptedNetworkAdapter', () => {
  return {
    VaultNetworkAdapter: class MockAdapter {
      setAccount = vi.fn()
      setSendEnabled = vi.fn()
      disconnect = mockAdapterDisconnect
    }
  }
})

const mockBrokerShutdown = vi.fn().mockResolvedValue(undefined)
vi.mock('./SyncMessageBroker', () => {
  return {
    SyncMessageBroker: class MockBroker {
      setOnlineState = vi.fn()
      setAccount = vi.fn()
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
})
