import { AutomergeRepoManager } from './AutomergeRepoManager'
import { VaultIndexedDBStorageAdapter } from './VaultIndexedDBStorageAdapter'
import type { VaultNetworkAdapter } from './VaultNetworkAdapter'
import * as storageManager from '../utils/storageManager'
import { createMockKeyProvider } from './__test__/testUtils'
import { spyOnExports } from '../../../test/moduleMocks'
import * as automergeRepo from '@automerge/automerge-repo/slim'
import * as encryptedBroadcastChannelNetworkAdapter from './EncryptedBroadcastChannelNetworkAdapter'
import * as vaultIndexedDBStorageAdapter from './VaultIndexedDBStorageAdapter'

beforeEach(() => {
  spyOnExports(automergeRepo, {
    Repo: class MockRepo {
      public storage: any
      public network: any
      constructor(opts: any) {
        this.storage = opts.storage
        this.network = opts.network
      }

      shutdown = vi.fn().mockResolvedValue(undefined)
    },
  })
  spyOnExports(encryptedBroadcastChannelNetworkAdapter, {
    EncryptedBroadcastChannelNetworkAdapter: class MockBroadcastAdapter {
      pause = vi.fn()
      resume = vi.fn()
      isSyncPaused = vi.fn().mockReturnValue(false)
      disconnect = vi.fn()
    },
  })
  spyOnExports(vaultIndexedDBStorageAdapter, {
    VaultIndexedDBStorageAdapter: class MockIndexedDBAdapter {
      save = vi.fn().mockResolvedValue(undefined)
      load = vi.fn().mockResolvedValue(undefined)
      remove = vi.fn().mockResolvedValue(undefined)
      loadRange = vi.fn().mockResolvedValue([])
      removeRange = vi.fn().mockResolvedValue(undefined)
      clear = vi.fn().mockResolvedValue(undefined)
      close = vi.fn().mockResolvedValue(undefined)
      has = vi.fn().mockResolvedValue(false)
    },
  })
})

describe('AutomergeRepoManager', () => {
  let manager: AutomergeRepoManager
  let mockVaultAdapter: VaultNetworkAdapter
  let storage: VaultIndexedDBStorageAdapter

  beforeEach(() => {
    vi.clearAllMocks()
    manager = new AutomergeRepoManager('account-1', createMockKeyProvider())
    mockVaultAdapter = {} as VaultNetworkAdapter
    storage = new VaultIndexedDBStorageAdapter('test-db')
  })

  it('initializes Repo with QuotaHandlingStorageAdapter', () => {
    const onQuotaError = vi.fn()
    const repo = manager.init(mockVaultAdapter, storage, { onQuotaError }) as any

    expect(repo).toBeDefined()
    expect(repo.storage).toBeDefined()
  })

  it('delegates save through runStorageOperation and invokes onQuotaError on quota failure', async () => {
    const onQuotaError = vi.fn()
    const repo = manager.init(mockVaultAdapter, storage, { onQuotaError }) as any

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

  it('awaits indexedDbAdapter.close() during manager.close()', async () => {
    manager.init(mockVaultAdapter, storage)
    // @ts-expect-error accessing private adapter
    const adapterCloseSpy = vi.spyOn(manager.indexedDbAdapter, 'close')

    await manager.close()
    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('delegates has through runStorageOperation', async () => {
    const repo = manager.init(mockVaultAdapter, storage) as any
    const runStorageSpy = vi.spyOn(storageManager, 'runStorageOperation')

    // @ts-expect-error accessing private adapter
    vi.spyOn(manager.indexedDbAdapter, 'has').mockResolvedValueOnce(true)

    const result = await repo.storage.has(['doc-1'])
    expect(result).toBe(true)
    expect(runStorageSpy).toHaveBeenCalled()
  })

  it('exposes wrapped storage via getters', () => {
    manager.init(mockVaultAdapter, storage)
    expect(manager.getStorage()).toBeDefined()
    expect(typeof manager.getStorage()?.has).toBe('function')
  })

  it('shuts down repo and closes adapter without clearing storage on lifecycle stop', async () => {
    const repo = manager.init(mockVaultAdapter, storage) as any
    const callOrder: string[] = []

    const repoShutdownSpy = vi.spyOn(repo, 'shutdown').mockImplementation(async () => {
      callOrder.push('repo.shutdown')
    })
    // @ts-expect-error accessing private adapter
    const adapterCloseSpy = vi.spyOn(manager.indexedDbAdapter, 'close').mockImplementation(async () => {
      callOrder.push('adapter.close')
    })

    await manager.onLifecycleStop({ clearLocalData: true })

    expect(callOrder).toEqual(['repo.shutdown', 'adapter.close'])
    expect(repoShutdownSpy).toHaveBeenCalledTimes(1)
    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('closes the adapter when clearLocalData is omitted', async () => {
    manager.init(mockVaultAdapter, storage)
    // @ts-expect-error accessing private adapter
    const adapterCloseSpy = vi.spyOn(manager.indexedDbAdapter, 'close').mockResolvedValue(undefined)

    await manager.onLifecycleStop()

    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })
})

