import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SyncBridge } from './SyncBridge'
import * as Comlink from 'comlink'
import { useSyncStore } from '../state/syncStore'
import { VAULT_STORAGE_KEY } from '../api/vault/util'

const mockSyncApi = {
  setOnlineState: vi.fn().mockResolvedValue(undefined),
  initRepo: vi.fn().mockResolvedValue(undefined),
  bootstrapLegacyItems: vi.fn().mockResolvedValue(undefined),
  clearAutomergeDocStore: vi.fn().mockResolvedValue(undefined),
  listRecoveryItems: vi.fn().mockResolvedValue([]),
  exportSyncState: vi.fn().mockResolvedValue({ cursors: [], pendingSync: [], lastModified: [] }),
  restoreSyncState: vi.fn().mockResolvedValue(undefined),
  forceSync: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
}

vi.mock('comlink', () => {
  return {
    wrap: vi.fn(() => mockSyncApi),
    proxy: vi.fn(cb => cb),
  }
})

class MockWorker {
  url: string
  options: any
  terminate = vi.fn()
  constructor(url: string, options: any) {
    this.url = url
    this.options = options
  }
}

describe('SyncBridge', () => {
  let originalWorker: any

  beforeEach(() => {
    originalWorker = globalThis.Worker
    globalThis.Worker = MockWorker as any
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify({ account: 'test-account', key: 'test-key' }))
    vi.clearAllMocks()
    useSyncStore.setState({ status: 'idle' })
  })

  afterEach(async () => {
    globalThis.Worker = originalWorker
    localStorage.clear()
    await SyncBridge.shutdown()
  })

  it('initializes and configures the sync worker', async () => {
    const initPromise = SyncBridge.initialize('test-account')
    expect(useSyncStore.getState().status).toBe('connecting')
    await initPromise

    expect(Comlink.wrap).toHaveBeenCalled()
    expect(mockSyncApi.setOnlineState).toHaveBeenCalled()
    expect(mockSyncApi.initRepo).toHaveBeenCalledWith(
      'test-account',
      'test-key',
      expect.any(Object)
    )
    expect(mockSyncApi.bootstrapLegacyItems).toHaveBeenCalled()
  })

  it('returns early and does not create a new worker if already initialized with the same account', async () => {
    await SyncBridge.initialize('test-account')
    expect(Comlink.wrap).toHaveBeenCalledTimes(1)

    // Call initialize again with the same account
    await SyncBridge.initialize('test-account')
    expect(Comlink.wrap).toHaveBeenCalledTimes(1)
  })

  it('terminates the active worker and initializes a new one when initialized with a different account', async () => {
    let terminateSpy1: any
    let terminateSpy2: any
    let workerIndex = 0

    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        if (workerIndex === 0) {
          terminateSpy1 = this.terminate
        } else {
          terminateSpy2 = this.terminate
        }
        workerIndex++
      }
    } as any

    await SyncBridge.initialize('account-one')
    expect(Comlink.wrap).toHaveBeenCalledTimes(1)
    expect(terminateSpy1).not.toHaveBeenCalled()

    // Call initialize again with a different account
    await SyncBridge.initialize('account-two')
    expect(terminateSpy1).toHaveBeenCalledTimes(1)
    expect(Comlink.wrap).toHaveBeenCalledTimes(2)
    expect(terminateSpy2).not.toHaveBeenCalled()
  })

  it('terminates the active worker and resets state on shutdown', async () => {
    let terminateSpy: any
    // Overwrite Worker constructor to capture the instance
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        terminateSpy = this.terminate
      }
    } as any

    await SyncBridge.initialize('test-account')
    expect(terminateSpy).not.toHaveBeenCalled()

    await SyncBridge.shutdown()
    expect(mockSyncApi.shutdown).toHaveBeenCalledTimes(1)
    expect(terminateSpy).toHaveBeenCalledTimes(1)
    expect(useSyncStore.getState().status).toBe('offline')

    // After shutdown, we should be able to initialize again (which spins up a new worker)
    let newTerminateSpy: any
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        newTerminateSpy = this.terminate
      }
    } as any

    await SyncBridge.initialize('test-account')
    expect(Comlink.wrap).toHaveBeenCalledTimes(2)
  })
})
