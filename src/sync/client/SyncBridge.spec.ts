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
      expect.any(Function)
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

  it('attempts to restart the worker if worker.onerror is triggered', async () => {
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
    expect(capturedWorker).not.toBeNull()

    // Trigger the onerror handler
    capturedWorker.onerror(new ErrorEvent('error', { message: 'WASM crash' }))

    // Expect status to be connecting, and reconnect warning set
    expect(useAppStore.getState().syncStatus).toBe('connecting')
    expect(useAppStore.getState().syncWarning).toBe('Sync connection lost. Reconnecting...')

    // Fast-forward 1000ms for the restart timer
    await vi.advanceTimersByTimeAsync(1000)

    expect(initializeSpy).toHaveBeenCalledTimes(2)
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
    capturedWorker.onerror(new ErrorEvent('error', { message: 'crash 1' }))
    await vi.advanceTimersByTimeAsync(1000) // triggers restart
    expect(initializeSpy).toHaveBeenCalledTimes(2)

    // Second crash
    capturedWorker.onerror(new ErrorEvent('error', { message: 'crash 2' }))
    await vi.advanceTimersByTimeAsync(1000) // triggers restart
    expect(initializeSpy).toHaveBeenCalledTimes(3)

    // Third crash
    capturedWorker.onerror(new ErrorEvent('error', { message: 'crash 3' }))

    // No more restarts. Fatal error should be set.
    expect(useAppStore.getState().fatalError).toBe('Sync worker crashed repeatedly. Please refresh the page to try again.')
    expect(useAppStore.getState().syncStatus).toBe('offline')
    expect(initializeSpy).toHaveBeenCalledTimes(3) // should not have incremented

    vi.useRealTimers()
  })

  it('responds to online, offline, and visibilitychange events', async () => {
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const visibilityStateSpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')

    await SyncBridge.initialize('test-account')
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(true)

    // Hidden -> should trigger setOnlineState(false)
    visibilityStateSpy.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(false)

    // Visible again -> should trigger setOnlineState(true)
    visibilityStateSpy.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(true)

    // Offline network event -> should trigger setOnlineState(false)
    onLineSpy.mockReturnValue(false)
    window.dispatchEvent(new Event('offline'))
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(false)

    // Online network event, but document hidden -> should trigger setOnlineState(false)
    onLineSpy.mockReturnValue(true)
    visibilityStateSpy.mockReturnValue('hidden')
    window.dispatchEvent(new Event('online'))
    expect(mockSyncApi.setOnlineState).toHaveBeenLastCalledWith(false)

    onLineSpy.mockRestore()
    visibilityStateSpy.mockRestore()
  })
})
