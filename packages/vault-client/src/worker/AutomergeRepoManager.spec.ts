import { AutomergeRepoManager } from './AutomergeRepoManager'
import { VaultIndexedDBStorageAdapter } from './VaultIndexedDBStorageAdapter'
import * as storageManager from '../utils/storageManager'
import { createMockKeyProvider } from './__test__/testUtils'
import { spyOnExports } from '../../test/moduleMocks'
import * as automergeRepo from '@automerge/automerge-repo/slim'
import * as encryptedBroadcastChannelNetworkAdapter from './EncryptedBroadcastChannelNetworkAdapter'
import * as vaultIndexedDBStorageAdapter from './VaultIndexedDBStorageAdapter'
import type { EncryptedBroadcastChannelOptions } from './EncryptedBroadcastChannelNetworkAdapter'
import { toDocumentIdFromItemId } from './utils/automerge'
import type { ItemId } from '@vault/shared'

let adapterOptions: EncryptedBroadcastChannelOptions | undefined

beforeEach(() => {
  spyOnExports(automergeRepo, {
    Repo: class MockRepo {
      public storage: any
      public network: any
      constructor(opts: any) {
        this.storage = opts.storage
        this.network = opts.network
      }

      handles = {}
      on = vi.fn()
      off = vi.fn()
      shutdown = vi.fn().mockResolvedValue(undefined)
    },
  })
  spyOnExports(encryptedBroadcastChannelNetworkAdapter, {
    EncryptedBroadcastChannelNetworkAdapter: class MockBroadcastAdapter {
      constructor(options: EncryptedBroadcastChannelOptions) {
        adapterOptions = options
      }

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
    manager = new AutomergeRepoManager('account-1', createMockKeyProvider(), storage)
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

  // The Repo's throttled saves can still run once it has shut down, and nothing handles their errors
  it('drops saves that arrive after the repo shut down, instead of writing to the closed database', async () => {
    const save = vi.spyOn(storage, 'save').mockRejectedValue(new Error('Database is closed'))

    await manager.close()

    await expect(repo.storage.save(['doc-1'], new Uint8Array([1]))).resolves.toBeUndefined()
    expect(save).not.toHaveBeenCalled()
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

  describe('doc change listeners', () => {
    const ITEM = 'item-1' as ItemId
    const documentId = toDocumentIdFromItemId(ITEM)

    function fakeHandle() {
      return { documentId, on: vi.fn(), off: vi.fn() }
    }

    it('listens to the handle for a doc another tab sent, and still passes the doc on', () => {
      const onDocChanged = vi.fn()
      const onDocumentReceived = vi.fn()
      manager = new AutomergeRepoManager('account-1', createMockKeyProvider(), storage, {
        onDocChanged,
        onDocumentReceived,
      })
      const handle = fakeHandle()
      ;(manager.repo as any).handles = { [documentId]: handle }

      adapterOptions?.onDocumentReceived?.(documentId)
      adapterOptions?.onDocumentReceived?.(documentId)

      expect(handle.on).toHaveBeenCalledTimes(1)
      // Counted as changed once, when first listened to, in case the message was applied already
      expect(onDocChanged).toHaveBeenCalledTimes(1)
      expect(onDocChanged).toHaveBeenCalledWith(ITEM)
      expect(onDocumentReceived).toHaveBeenCalledTimes(2)
      handle.on.mock.calls[0][1]()
      expect(onDocChanged).toHaveBeenCalledTimes(2)
    })

    it('removes the listeners it added on close, with the same reference', async () => {
      const handle = fakeHandle()
      manager.watchHandle(handle as any)

      await manager.close()

      expect(handle.off).toHaveBeenCalledWith('change', handle.on.mock.calls[0][1])
    })
  })
})

