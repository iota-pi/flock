import { SyncBridge } from './SyncBridge'
import * as Comlink from 'comlink'
import { useAppStore } from '../../state/store'
import { VAULT_STORAGE_KEY } from '../../api/vault/util'

vi.mock('src/api/vault', () => ({
  exportKeyringData: vi.fn().mockResolvedValue('test-key'),
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
  shutdown: vi.fn().mockResolvedValue(undefined),
  ping: vi.fn().mockResolvedValue(undefined),
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
  postMessage = vi.fn()
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
      }
    } as any

    // Mock ping to hang forever
    mockSyncApi.ping.mockImplementation(() => new Promise(() => {}))

    const initializeSpy = vi.spyOn(SyncBridge, 'initialize')
    await SyncBridge.initialize('test-account')

    // Move time forward by HEARTBEAT_INTERVAL (15s) + HEARTBEAT_TIMEOUT (5s)
    await vi.advanceTimersByTimeAsync(20000)

    expect(useAppStore.getState().syncStatus).toBe('connecting')
    expect(useAppStore.getState().syncWarning).toBe('Sync connection lost. Reconnecting...')

    // Fast-forward another 1000ms for the restart timer
    await vi.advanceTimersByTimeAsync(1000)
    expect(initializeSpy).toHaveBeenCalledTimes(2)

    // Clean up mock
    mockSyncApi.ping.mockReset().mockResolvedValue(undefined)
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
    expect(useAppStore.getState().syncStatus).toBe('offline')
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

  it('closes _globalEventChannel.port1 on worker crash', async () => {
    let capturedWorker: any = null
    globalThis.Worker = class extends MockWorker {
      constructor(url: string, options: any) {
        super(url, options)
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        capturedWorker = this
      }
    } as any

    const originalMessageChannel = globalThis.MessageChannel
    let port1CloseSpy: any
    class MockMessageChannel {
      port1 = {
        onmessage: null,
        start: vi.fn(),
        close: vi.fn(),
      }

      port2 = {}

      constructor() {
        port1CloseSpy = this.port1.close
      }
    }
    globalThis.MessageChannel = MockMessageChannel as any

    try {
      await SyncBridge.initialize('test-account')
      expect(capturedWorker).not.toBeNull()
      expect(port1CloseSpy).not.toHaveBeenCalled()

      // Trigger worker crash error
      capturedWorker.dispatchEvent(new ErrorEvent('error', { message: 'crash' }))

      expect(port1CloseSpy).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.MessageChannel = originalMessageChannel
    }
  })

  it('re-throws error when initialization fails', async () => {
    mockSyncApi.initRepo.mockRejectedValueOnce(new Error('initRepo failed'))

    await expect(SyncBridge.initialize('fail-account')).rejects.toThrow('initRepo failed')
    expect(useAppStore.getState().syncStatus).toBe('offline')
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
})

