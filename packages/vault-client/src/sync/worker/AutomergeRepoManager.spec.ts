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
  let storage: VaultIndexedDBStorageAdapter
  let repo: any

  beforeEach(() => {
    vi.clearAllMocks()
    storage = new VaultIndexedDBStorageAdapter('test-db')
    manager = new AutomergeRepoManager('account-1', createMockKeyProvider(), {} as VaultNetworkAdapter, storage)
    repo = manager.repo
  })

  it('builds the Repo on the quota-handling storage', () => {
    expect(repo.storage).toBe(manager.storage)
  })

  it('delegates save through runStorageOperation and rethrows a quota failure', async () => {
    const runStorageSpy = vi.spyOn(storageManager, 'runStorageOperation')
    const quotaError = new DOMException('Quota exceeded', 'QuotaExceededError')

    // Simulate underlying adapter throwing QuotaExceededError
    vi.spyOn(storage, 'save').mockRejectedValueOnce(quotaError)

    await expect(
      repo.storage.save(['doc-1'], new Uint8Array([1, 2, 3]))
    ).rejects.toThrow('Quota exceeded')

    expect(runStorageSpy).toHaveBeenCalled()
  })

  it('awaits indexedDbAdapter.close() during manager.close()', async () => {
    const adapterCloseSpy = vi.spyOn(storage, 'close')

    await manager.close()
    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('delegates has through runStorageOperation', async () => {
    const runStorageSpy = vi.spyOn(storageManager, 'runStorageOperation')

    vi.spyOn(storage, 'has').mockResolvedValueOnce(true)

    const result = await repo.storage.has(['doc-1'])
    expect(result).toBe(true)
    expect(runStorageSpy).toHaveBeenCalled()
  })

  it('shuts down repo and closes adapter without clearing storage on close', async () => {
    const callOrder: string[] = []

    const repoShutdownSpy = vi.spyOn(repo, 'shutdown').mockImplementation(async () => {
      callOrder.push('repo.shutdown')
    })
    const adapterCloseSpy = vi.spyOn(storage, 'close').mockImplementation(async () => {
      callOrder.push('adapter.close')
    })

    await manager.close()

    expect(callOrder).toEqual(['repo.shutdown', 'adapter.close'])
    expect(repoShutdownSpy).toHaveBeenCalledTimes(1)
    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('closes the adapter when clearLocalData is omitted', async () => {
    const adapterCloseSpy = vi.spyOn(storage, 'close').mockResolvedValue(undefined)

    await manager.close()

    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })

  it('closes only once', async () => {
    const adapterCloseSpy = vi.spyOn(storage, 'close')

    await manager.close()
    await manager.close()

    expect(repo.shutdown).toHaveBeenCalledTimes(1)
    expect(adapterCloseSpy).toHaveBeenCalledTimes(1)
  })
})

