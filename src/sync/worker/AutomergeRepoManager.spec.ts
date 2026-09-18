import { AutomergeRepoManager } from './AutomergeRepoManager'
import type { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import * as storageManager from '../../utils/storageManager'

vi.mock('@automerge/automerge-repo/slim', () => {
  return {
    Repo: class MockRepo {
      public storage: any
      public network: any
      constructor(opts: any) {
        this.storage = opts.storage
        this.network = opts.network
      }

      shutdown = vi.fn().mockResolvedValue(undefined)
    },
  }
})

vi.mock('./EncryptedBroadcastChannelNetworkAdapter', () => {
  return {
    EncryptedBroadcastChannelNetworkAdapter: class MockBroadcastAdapter {
      pause = vi.fn()
      resume = vi.fn()
      isSyncPaused = vi.fn().mockReturnValue(false)
      disconnect = vi.fn()
    },
  }
})

vi.mock('./FlockIndexedDBStorageAdapter', () => {
  return {
    FlockIndexedDBStorageAdapter: class MockIndexedDBAdapter {
      save = vi.fn().mockResolvedValue(undefined)
      load = vi.fn().mockResolvedValue(undefined)
      remove = vi.fn().mockResolvedValue(undefined)
      loadRange = vi.fn().mockResolvedValue([])
      removeRange = vi.fn().mockResolvedValue(undefined)
      clear = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
    },
  }
})

describe('AutomergeRepoManager', () => {
  let manager: AutomergeRepoManager
  let mockVaultAdapter: VaultNetworkAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new AutomergeRepoManager('account-1')
    mockVaultAdapter = {} as VaultNetworkAdapter
  })

  it('initializes Repo with QuotaHandlingStorageAdapter', () => {
    const onQuotaError = vi.fn()
    const repo = manager.init(mockVaultAdapter, { onQuotaError }) as any

    expect(repo).toBeDefined()
    expect(repo.storage).toBeDefined()
  })

  it('delegates save through runStorageOperation and invokes onQuotaError on quota failure', async () => {
    const onQuotaError = vi.fn()
    const repo = manager.init(mockVaultAdapter, { onQuotaError }) as any

    const runStorageSpy = vi.spyOn(storageManager, 'runStorageOperation')
    const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError')

    // Simulate underlying adapter throwing QuotaExceededError
    // @ts-expect-error accessing private adapter
    vi.spyOn(manager.indexedDbAdapter, 'save').mockRejectedValueOnce(quotaError)

    await expect(
      repo.storage.save(['doc-1'], new Uint8Array([1, 2, 3]))
    ).rejects.toThrow('Quota exceeded')

    expect(runStorageSpy).toHaveBeenCalled()
    expect(onQuotaError).toHaveBeenCalledWith(quotaError)
  })

  it('wraps clearLocalData in runStorageOperation', async () => {
    manager.init(mockVaultAdapter)
    const runStorageSpy = vi.spyOn(storageManager, 'runStorageOperation')

    await manager.clearLocalData()
    expect(runStorageSpy).toHaveBeenCalled()
  })

  it('awaits indexedDbAdapter.close() during manager.close()', async () => {
    manager.init(mockVaultAdapter)
    // @ts-expect-error accessing private adapter
    const adapterCloseSpy = vi.spyOn(manager.indexedDbAdapter, 'close')

    await manager.close()
    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })
})
