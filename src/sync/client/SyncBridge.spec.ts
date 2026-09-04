import { SyncBridge } from './SyncBridge'
import * as Comlink from 'comlink'
import { useAppStore } from '../../state/store'
import { VAULT_STORAGE_KEY } from '../../api/vault/util'
import type { ItemId } from 'src/shared/schemas/items'
import { getBlankPerson } from '../../state/items'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'

vi.mock('src/api/vault', () => ({
  exportKeyringData: vi.fn().mockResolvedValue('test-key'),
  reloadKeyringFromStorage: vi.fn().mockResolvedValue({ success: true, keyringData: 'reloaded-key' }),
  lockVault: vi.fn().mockResolvedValue(undefined),
  KEYRING_CACHE_KEY: 'FlockKeyringCache',
  VAULT_EVENTS_CHANNEL: 'flock-vault-events',
}))


const mockSyncApi = {
  setOnlineState: vi.fn().mockResolvedValue(undefined),
  initRepo: vi.fn().mockResolvedValue(undefined),
  bootstrapItems: vi.fn().mockResolvedValue(undefined),
  clearAutomergeDocStore: vi.fn().mockResolvedValue(undefined),
  listRecoveryItems: vi.fn().mockResolvedValue([]),
  exportSyncState: vi.fn().mockResolvedValue({ cursors: [], pendingSync: [], lastModified: [] }),
  restoreSyncState: vi.fn().mockResolvedValue(undefined),
  forceSync: vi.fn().mockResolvedValue(undefined),
  fullResync: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  mutateItem: vi.fn().mockResolvedValue(undefined),
  createItem: vi.fn().mockResolvedValue(undefined),
  storeItems: vi.fn().mockResolvedValue(undefined),
  mutateMetadata: vi.fn().mockResolvedValue(undefined),
  exportAllBinaries: vi.fn().mockResolvedValue({ documents: {}, skipped: [] }),
  restoreFromBinaries: vi.fn().mockResolvedValue(['doc-1']),
  retryRecoveryItem: vi.fn().mockResolvedValue(undefined),
  forceOverwriteRecoveryItem: vi.fn().mockResolvedValue(undefined),
  forceDeleteRecoveryItem: vi.fn().mockResolvedValue(undefined),
  dismissRecoveryItem: vi.fn().mockResolvedValue(undefined),
  updateVaultKey: vi.fn().mockResolvedValue(undefined),
  reencryptAllItems: vi.fn().mockResolvedValue({ succeeded: [], failed: [] }),
  flushSync: vi.fn().mockReturnValue(undefined),
  pushSnapshots: vi.fn().mockResolvedValue({ persisted: 0, total: 0 }),
}

vi.mock('comlink', () => {
  return {
    wrap: vi.fn(() => mockSyncApi),
    proxy: vi.fn(cb => cb),
  }
})

let lastEventPort: MessagePort | null = null

class MockWorker {
  url: string
  options: any
  terminate = vi.fn()
  postMessage = vi.fn((data: any) => {
    if (data && data.type === 'EVENT_PORT' && data.port) {
      lastEventPort = data.port
    }
    if (data && data.type === 'INIT_PING_PORT' && data.port) {
      const port = data.port
      const reply = () => {
        port.postMessage?.('pong')
      }
      if (typeof port.addEventListener === 'function') {
        port.addEventListener('message', (event: any) => {
          if (event.data === 'ping') reply()
        })
      }
      port.onmessage = (event: any) => {
        if (event.data === 'ping') reply()
      }
      if (typeof port.start === 'function') {
        port.start()
      }
    }
  })

  private listeners: Record<string, ((event: any) => void)[]> = {}

  addEventListener = vi.fn((event: string, handler: (event: any) => void) => {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(handler)
  })

  removeEventListener = vi.fn((event: string, handler: (event: any) => void) => {
    if (this.listeners[event]) {
      this.listeners[event] = this.listeners[event].filter(h => h !== handler)
    }
  })

  dispatchEvent = vi.fn((event: any) => {
    const handlers = this.listeners[event.type] || []
    handlers.forEach(h => h(event))
    return true
  })

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
    mockSyncApi.setOnlineState.mockResolvedValue(undefined)
    mockSyncApi.initRepo.mockResolvedValue(undefined)
    mockSyncApi.bootstrapItems.mockResolvedValue(undefined)
    mockSyncApi.clearAutomergeDocStore.mockResolvedValue(undefined)
    mockSyncApi.listRecoveryItems.mockResolvedValue([])
    mockSyncApi.exportSyncState.mockResolvedValue({ cursors: [], pendingSync: [], lastModified: [] })
    mockSyncApi.restoreSyncState.mockResolvedValue(undefined)
    mockSyncApi.forceSync.mockResolvedValue(undefined)
    mockSyncApi.fullResync.mockResolvedValue(undefined)
    mockSyncApi.shutdown.mockResolvedValue(undefined)
    mockSyncApi.mutateItem.mockResolvedValue(undefined)
    mockSyncApi.createItem.mockResolvedValue(undefined)
    mockSyncApi.storeItems.mockResolvedValue(undefined)
    mockSyncApi.mutateMetadata.mockResolvedValue(undefined)
    mockSyncApi.exportAllBinaries.mockResolvedValue({ documents: {}, skipped: [] })
    mockSyncApi.restoreFromBinaries.mockResolvedValue(['doc-1'])
    mockSyncApi.retryRecoveryItem.mockResolvedValue(undefined)
    mockSyncApi.forceOverwriteRecoveryItem.mockResolvedValue(undefined)
    mockSyncApi.forceDeleteRecoveryItem.mockResolvedValue(undefined)
    mockSyncApi.dismissRecoveryItem.mockResolvedValue(undefined)
    mockSyncApi.updateVaultKey.mockResolvedValue(undefined)
    mockSyncApi.reencryptAllItems.mockResolvedValue(undefined)
    mockSyncApi.flushSync.mockReturnValue(undefined)
    useAppStore.setState({ syncStatus: 'idle', fatalError: null, syncWarning: null })
  })

  afterEach(async () => {
    globalThis.Worker = originalWorker
    localStorage.clear()
    await SyncBridge.shutdown()
    vi.restoreAllMocks()
  })

  it('initializes and configures the sync worker', async () => {
    const initPromise = SyncBridge.initialize('test-account')
    expect(useAppStore.getState().syncStatus).toBe('connecting')
    await initPromise

    expect(Comlink.wrap).toHaveBeenCalled()
    expect(mockSyncApi.setOnlineState).toHaveBeenCalled()
    expect(mockSyncApi.initRepo).toHaveBeenCalledWith(
      'test-account',
      'test-key',
    )
    expect(mockSyncApi.bootstrapItems).toHaveBeenCalled()
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
        workerIndex += 1
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
    expect(useAppStore.getState().syncStatus).toBe('offline')

    // After shutdown, we should be able to initialize again (which spins up a new worker)
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
      }
    } as any

    await SyncBridge.initialize('test-account')
    expect(Comlink.wrap).toHaveBeenCalledTimes(2)
  })

  it('attempts to restart the worker and dispatches to window if worker error event is triggered', async () => {
    vi.useFakeTimers()
    let capturedWorker: any = null
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        capturedWorker = this
      }
    } as any

    const windowDispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const initializeSpy = vi.spyOn(SyncBridge, 'initialize')
    await SyncBridge.initialize('test-account')
    expect(capturedWorker).not.toBeNull()

    // Trigger the error event
    capturedWorker.dispatchEvent(new ErrorEvent('error', { message: 'WASM crash' }))

    // Expect window error event dispatched
    expect(windowDispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'WASM crash' })
    )

    // Expect status to be connecting, and reconnect warning set
    expect(useAppStore.getState().syncStatus).toBe('connecting')
    expect(useAppStore.getState().syncWarning).toBe('Sync connection lost. Reconnecting...')

    // Fast-forward 1000ms for the restart timer
    await vi.advanceTimersByTimeAsync(1000)

    expect(initializeSpy).toHaveBeenCalledTimes(2)
    windowDispatchSpy.mockRestore()
    vi.useRealTimers()
  })

  it('detects a hung worker via heartbeat and restarts it', async () => {
    vi.useFakeTimers()
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        // Mock ping port to hang / not respond
        this.postMessage = vi.fn()
      }
    } as any

    const initializeSpy = vi.spyOn(SyncBridge, 'initialize')
    await SyncBridge.initialize('test-account')

    // Move time forward by HEARTBEAT_INTERVAL (15s) + HEARTBEAT_TIMEOUT (30s)
    await vi.advanceTimersByTimeAsync(45000)

    expect(useAppStore.getState().syncStatus).toBe('connecting')
    expect(useAppStore.getState().syncWarning).toBe('Sync connection lost. Reconnecting...')

    // Fast-forward another 1000ms for the restart timer
    await vi.advanceTimersByTimeAsync(1000)
    expect(initializeSpy).toHaveBeenCalledTimes(2)

    vi.useRealTimers()
  })

  it('halts auto-restart and sets a fatal error after 3 consecutive crashes', async () => {
    vi.useFakeTimers()
    let capturedWorker: any = null
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        capturedWorker = this
      }
    } as any

    const initializeSpy = vi.spyOn(SyncBridge, 'initialize')
    await SyncBridge.initialize('test-account')

    // First crash
    capturedWorker.dispatchEvent(new ErrorEvent('error', { message: 'crash 1' }))
    await vi.advanceTimersByTimeAsync(1000) // triggers restart
    expect(initializeSpy).toHaveBeenCalledTimes(2)

    // Second crash
    capturedWorker.dispatchEvent(new ErrorEvent('error', { message: 'crash 2' }))
    await vi.advanceTimersByTimeAsync(1000) // triggers restart
    expect(initializeSpy).toHaveBeenCalledTimes(3)

    // Third crash
    capturedWorker.dispatchEvent(new ErrorEvent('error', { message: 'crash 3' }))

    // No more restarts. Fatal error should be set.
    expect(useAppStore.getState().fatalError).toBe('Sync worker crashed repeatedly. Please refresh the page to try again.')
    expect(useAppStore.getState().syncStatus).toBe('dead')
    expect(initializeSpy).toHaveBeenCalledTimes(3) // should not have incremented

    vi.useRealTimers()
  })

  it('responds to online and offline events', async () => {
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)

    await SyncBridge.initialize('test-account')
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(true)

    // Offline network event -> should trigger setOnlineState(false)
    onLineSpy.mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(false)

    // Online network event -> should trigger setOnlineState(true)
    onLineSpy.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(true)

    onLineSpy.mockRestore()
  })

  it('removes online, offline, and visibility event listeners on shutdown', async () => {
    const windowRemoveSpy = vi.spyOn(window, 'removeEventListener')
    const documentRemoveSpy = vi.spyOn(document, 'removeEventListener')

    await SyncBridge.initialize('test-account')
    await SyncBridge.shutdown()

    expect(windowRemoveSpy).toHaveBeenCalledWith('online', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('offline', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('pagehide', expect.any(Function))
    expect(windowRemoveSpy).toHaveBeenCalledWith('storage', expect.any(Function))
    expect(documentRemoveSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    windowRemoveSpy.mockRestore()
    documentRemoveSpy.mockRestore()
  })

  it('triggers pushSnapshots when document becomes hidden', async () => {
    await SyncBridge.initialize('test-account')

    const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))

    expect(mockSyncApi.pushSnapshots).toHaveBeenCalledTimes(1)

    visibilitySpy.mockRestore()
  })

  it('reloads keyring and updates worker on storage event for KEYRING_CACHE_KEY', async () => {
    const { reloadKeyringFromStorage } = await import('src/api/vault')
    vi.mocked(reloadKeyringFromStorage).mockResolvedValueOnce({
      success: true,
      keyringData: 'new-keyring-version-2',
    })

    await SyncBridge.initialize('test-account')

    const storageEvent = new StorageEvent('storage', {
      key: 'FlockKeyringCache',
    })
    window.dispatchEvent(storageEvent)

    await vi.waitFor(() => {
      expect(reloadKeyringFromStorage).toHaveBeenCalledWith('test-account')
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('new-keyring-version-2')
    })
  })

  it('locks vault when storage reload indicates passwordChanged', async () => {
    const { reloadKeyringFromStorage, lockVault } = await import('src/api/vault')
    vi.mocked(reloadKeyringFromStorage).mockResolvedValueOnce({
      success: false,
      passwordChanged: true,
    })

    await SyncBridge.initialize('test-account')

    const storageEvent = new StorageEvent('storage', {
      key: 'FlockKeyringCache',
    })
    window.dispatchEvent(storageEvent)

    await vi.waitFor(() => {
      expect(lockVault).toHaveBeenCalled()
    })
  })

  it('reloads keyring and updates worker when keyVersionMissing event is received', async () => {
    const { reloadKeyringFromStorage } = await import('src/api/vault')
    vi.mocked(reloadKeyringFromStorage).mockResolvedValueOnce({
      success: true,
      keyringData: 'new-keyring-version-3',
    })

    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '3' })

    await vi.waitFor(() => {
      expect(reloadKeyringFromStorage).toHaveBeenCalledWith('test-account')
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('new-keyring-version-3')
    })
  })

  it('does not terminate a new worker if initialize() is called concurrently while shutdown() is awaiting worker shutdown', async () => {
    let worker1Terminate: any
    let worker2Terminate: any
    let workerCount = 0

    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        if (workerCount === 0) {
          worker1Terminate = this.terminate
        } else {
          worker2Terminate = this.terminate
        }
        workerCount += 1
      }
    } as any

    await SyncBridge.initialize('test-account')
    expect(workerCount).toBe(1)

    let resolveShutdown: () => void = () => {}
    mockSyncApi.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => {
      resolveShutdown = resolve
    }))

    const shutdownPromise = SyncBridge.shutdown()
    const initPromise = SyncBridge.initialize('test-account-2')

    resolveShutdown()
    await shutdownPromise
    await initPromise

    expect(worker1Terminate).toHaveBeenCalledTimes(1)
    expect(worker2Terminate).not.toHaveBeenCalled()
    expect(useAppStore.getState().syncStatus).not.toBe('offline')
  })

  it('resets initializationPromise when initialization is aborted due to concurrent account change', async () => {
    let resolveKeyring1: (val: string) => void = () => {}
    const { exportKeyringData } = await import('src/api/vault')
    vi.mocked(exportKeyringData).mockImplementationOnce(
      () => new Promise<string>(resolve => { resolveKeyring1 = resolve })
    )

    const init1 = SyncBridge.initialize('account-1')
    const init2 = SyncBridge.initialize('account-2')

    resolveKeyring1('test-key')
    await init1
    await init2

    // Should be successfully initialized with account-2, and ensureReady should not throw
    await expect(SyncBridge.ensureReady()).resolves.toBeUndefined()
  })

  it('flushes item updates asynchronously via setTimeout', async () => {
    let capturedEventPort: MessagePort | null = null
    globalThis.Worker = class extends MockWorker {
      postMessage = vi.fn((msg: any) => {
        if (msg?.type === 'EVENT_PORT') {
          capturedEventPort = msg.port
        }
      })
    } as any

    const updateItemsSpy = vi.spyOn(useAppStore.getState(), 'updateItemsFromServer')

    await SyncBridge.initialize('test-account')
    expect(capturedEventPort).not.toBeNull()

    capturedEventPort!.postMessage({
      type: 'itemUpdated',
      id: 'item-1',
      item: { id: 'item-1', name: 'Test Item' } as any,
    })

    // Should not have updated synchronously
    expect(updateItemsSpy).not.toHaveBeenCalled()

    // Wait for macro-task / setTimeout 0
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(updateItemsSpy).toHaveBeenCalledWith([
      { id: 'item-1', item: expect.objectContaining({ id: 'item-1', name: 'Test Item' }) },
    ])
  })

  it('closes _globalEventChannel.port1 and _pingChannel.port1 on worker crash', async () => {
    let capturedWorker: any = null
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        capturedWorker = this
      }
    } as any

    const originalMessageChannel = globalThis.MessageChannel
    const closeSpies: any[] = []
    class MockMessageChannel {
      port1 = {
        onmessage: null,
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      }

      port2 = {
        start: vi.fn(),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        postMessage: vi.fn(),
      }

      constructor() {
        closeSpies.push(this.port1.close)
      }
    }
    globalThis.MessageChannel = MockMessageChannel as any

    try {
      await SyncBridge.initialize('test-account')
      expect(capturedWorker).not.toBeNull()
      expect(closeSpies.length).toBe(2)
      closeSpies.forEach(spy => expect(spy).not.toHaveBeenCalled())

      // Trigger worker crash error
      capturedWorker.dispatchEvent(new ErrorEvent('error', { message: 'crash' }))

      closeSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1))
    } finally {
      globalThis.MessageChannel = originalMessageChannel
    }
  })

  it('schedules retry with backoff on initialization failure and queues ensureReady callers', async () => {
    vi.useFakeTimers()
    mockSyncApi.initRepo.mockRejectedValueOnce(new Error('initRepo failed transiently'))

    const initPromise = SyncBridge.initialize('retry-account')
    await expect(initPromise).rejects.toThrow('initRepo failed transiently')

    // Warning is set
    expect(useAppStore.getState().syncWarning).toBe('Sync initialization failed. Retrying in 2s...')

    // ensureReady callers wait on the retry
    let ready = false
    const ensureReadyPromise = SyncBridge.ensureReady().then(() => {
      ready = true
    })

    // Advance 1s - still waiting
    await vi.advanceTimersByTimeAsync(1000)
    expect(ready).toBe(false)

    // Advance remaining 1000ms - retry runs and succeeds
    await vi.advanceTimersByTimeAsync(1000)
    await ensureReadyPromise
    expect(ready).toBe(true)
    expect(mockSyncApi.initRepo).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().syncWarning).toBeNull()

    vi.useRealTimers()
  })

  it('exhausts retries after 5 attempts and sets fatal error', async () => {
    vi.useFakeTimers()
    mockSyncApi.initRepo.mockRejectedValue(new Error('persistent failure'))

    // Attempt 1 fails
    await expect(SyncBridge.initialize('fail-account')).rejects.toThrow('persistent failure')

    // Delays: 2000, 5000, 10000, 30000, 60000
    const delays = [2000, 5000, 10000, 30000, 60000]
    for (let i = 0; i < delays.length; i++) {
      await vi.advanceTimersByTimeAsync(delays[i])
    }

    expect(useAppStore.getState().fatalError).toBe('Unable to start sync. Please refresh the page.')
    expect(useAppStore.getState().syncStatus).toBe('offline')

    vi.useRealTimers()
  })

  it('cancels retry when account changes during retry delay', async () => {
    vi.useFakeTimers()
    mockSyncApi.initRepo.mockRejectedValueOnce(new Error('account 1 failed'))

    await expect(SyncBridge.initialize('account-fail')).rejects.toThrow('account 1 failed')
    expect(useAppStore.getState().syncWarning).toBe('Sync initialization failed. Retrying in 2s...')

    // Switch account before retry timer fires
    const initTwo = SyncBridge.initialize('account-success')
    await initTwo

    // Advance timer for old retry
    await vi.advanceTimersByTimeAsync(2000)

    // Should be initialized with account-success, not failed account
    expect(mockSyncApi.initRepo).toHaveBeenLastCalledWith('account-success', 'test-key')

    vi.useRealTimers()
  })

  it('queues mutations during worker crash and applies them after restart', async () => {
    vi.useFakeTimers()
    let capturedWorker: any = null
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        capturedWorker = this
      }
    } as any

    await SyncBridge.initialize('test-account')
    expect(capturedWorker).not.toBeNull()

    // Crash the worker
    capturedWorker.dispatchEvent(new ErrorEvent('error', { message: 'crash' }))

    // Issue mutation during restart gap
    let mutationResolved = false
    const mutatePromise = SyncBridge.mutateItem('item-1' as ItemId, { name: 'queued' }).then(() => {
      mutationResolved = true
    })

    // Advance 500ms (still within 1000ms restart gap)
    await vi.advanceTimersByTimeAsync(500)
    expect(mutationResolved).toBe(false)

    // Advance remaining 500ms to trigger auto-restart
    await vi.advanceTimersByTimeAsync(500)
    await mutatePromise

    expect(mutationResolved).toBe(true)
    expect(mockSyncApi.mutateItem).toHaveBeenCalledWith('item-1', { name: 'queued' })

    vi.useRealTimers()
  })

  it('allows ensureReady to wait for initialization during re-initialization with a new account', async () => {
    await SyncBridge.initialize('account-one')

    let resolveInitRepo: () => void = () => {}
    mockSyncApi.initRepo.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          resolveInitRepo = resolve
        })
    )

    const initTwoPromise = SyncBridge.initialize('account-two')
    const ensureReadyPromise = SyncBridge.ensureReady()

    // ensureReady should be pending and not throw prematurely
    let ready = false
    ensureReadyPromise.then(() => {
      ready = true
    })

    await new Promise(r => setTimeout(r, 10))
    expect(ready).toBe(false)

    resolveInitRepo()
    await initTwoPromise
    await ensureReadyPromise
    expect(ready).toBe(true)
  })

  it('safely handles concurrent initialize calls for different accounts without destroying the newer promise', async () => {
    let resolveKeyringA: (val: string) => void = () => {}
    let resolveKeyringB: (val: string) => void = () => {}

    const { exportKeyringData } = await import('src/api/vault')
    vi.mocked(exportKeyringData)
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveKeyringA = resolve }))
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveKeyringB = resolve }))

    const initAPromise = SyncBridge.initialize('account-A')
    const initBPromise = SyncBridge.initialize('account-B')

    const ensureReadyPromise = SyncBridge.ensureReady()

    let ready = false
    ensureReadyPromise.then(() => {
      ready = true
    })

    // Release A's keyring -> A discovers account changed to B and aborts
    resolveKeyringA('key-a')
    await initAPromise

    // ensureReady should still be pending on B
    await new Promise(r => setTimeout(r, 10))
    expect(ready).toBe(false)

    // Release B's keyring -> B finishes
    resolveKeyringB('key-b')
    await initBPromise
    await ensureReadyPromise
    expect(ready).toBe(true)
  })

  it('preserves recovery entries subscriptions and app store state on shutdown with internalRestart', async () => {
    await SyncBridge.initialize('test-account')

    const recoveryListener = vi.fn()
    SyncBridge.subscribeRecoveryItems(recoveryListener)
    expect(recoveryListener).toHaveBeenCalledTimes(1)

    useAppStore.setState({ items: { 'item-1': { id: 'item-1' } as any } })

    await SyncBridge.shutdown({ internalRestart: true })

    // Listener shouldn't have been called with empty array upon shutdown
    expect(recoveryListener).toHaveBeenCalledTimes(1)
    // App store state shouldn't be reset
    expect(useAppStore.getState().items['item-1']).toBeDefined()
  })

  describe('proxied worker methods', () => {
    it('throws an error if proxied methods are called before initialization', async () => {
      await expect(SyncBridge.mutateItem('item-1' as ItemId, { name: 'Test' })).rejects.toThrow(
        'SyncBridge not initialized'
      )
      await expect(SyncBridge.fullResync()).rejects.toThrow('SyncBridge not initialized')
      await expect(SyncBridge.exportSyncState()).rejects.toThrow('SyncBridge not initialized')
    })

    it('forwards proxied method calls with arguments to syncApi when initialized', async () => {
      await SyncBridge.initialize('test-account')

      const person = getBlankPerson('item-2' as ItemId, false)
      const person3 = getBlankPerson('item-3' as ItemId, false)

      await SyncBridge.mutateItem('item-1' as ItemId, { name: 'Updated' })
      expect(mockSyncApi.mutateItem).toHaveBeenCalledWith('item-1', { name: 'Updated' })

      await SyncBridge.createItem(person)
      expect(mockSyncApi.createItem).toHaveBeenCalledWith(person)

      await SyncBridge.storeItems([person3])
      expect(mockSyncApi.storeItems).toHaveBeenCalledWith([person3])

      await SyncBridge.mutateMetadata({ prayerGoal: 10 })
      expect(mockSyncApi.mutateMetadata).toHaveBeenCalledWith({ prayerGoal: 10 })

      await SyncBridge.flushSync()
      expect(mockSyncApi.flushSync).toHaveBeenCalledTimes(1)

      await SyncBridge.fullResync()
      expect(mockSyncApi.fullResync).toHaveBeenCalledTimes(1)

      const exported = await SyncBridge.exportAllBinaries()
      expect(mockSyncApi.exportAllBinaries).toHaveBeenCalledTimes(1)
      expect(exported).toEqual({ documents: {}, skipped: [] })

      await SyncBridge.retryRecoveryItem('item-1' as ItemId)
      expect(mockSyncApi.retryRecoveryItem).toHaveBeenCalledWith('item-1')

      await SyncBridge.forceOverwriteRecoveryItem('item-1' as ItemId)
      expect(mockSyncApi.forceOverwriteRecoveryItem).toHaveBeenCalledWith('item-1')

      await SyncBridge.forceDeleteRecoveryItem('item-1' as ItemId)
      expect(mockSyncApi.forceDeleteRecoveryItem).toHaveBeenCalledWith('item-1')

      await SyncBridge.dismissRecoveryItem('entry-1')
      expect(mockSyncApi.dismissRecoveryItem).toHaveBeenCalledWith('entry-1')

      await SyncBridge.updateVaultKey('new-key')
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('new-key')

      const syncState = await SyncBridge.exportSyncState()
      expect(mockSyncApi.exportSyncState).toHaveBeenCalledTimes(1)
      expect(syncState).toEqual({ cursors: [], pendingSync: [], lastModified: [] })

      await SyncBridge.restoreSyncState({ cursors: [] })
      expect(mockSyncApi.restoreSyncState).toHaveBeenCalledWith({ cursors: [] })
    })

    it('handles custom override methods correctly', async () => {
      await SyncBridge.initialize('test-account')

      const incrementSpy = vi.spyOn(useAppStore.getState(), 'incrementGeneration')
      const restoreResult = await SyncBridge.restoreFromBinaries({ doc1: 'data' })
      expect(mockSyncApi.restoreFromBinaries).toHaveBeenCalledWith({ doc1: 'data' })
      expect(incrementSpy).toHaveBeenCalledTimes(1)
      expect(restoreResult).toEqual(['doc-1'])

      const onProgress = vi.fn()
      await SyncBridge.reencryptAllItems(onProgress)
      expect(mockSyncApi.reencryptAllItems).toHaveBeenCalledTimes(1)
      expect(Comlink.proxy).toHaveBeenCalledWith(onProgress)

      const entries: ManualRecoveryEntry[] = [
        {
          id: 'rec-1',
          itemId: 'item-1' as ItemId,
          reason: 'invalid document',
          createdAt: 123456,
        },
      ]
      mockSyncApi.listRecoveryItems.mockResolvedValueOnce(entries)
      const listResult = await SyncBridge.listRecoveryItems()
      expect(listResult).toEqual(entries)
    })

  })
})

