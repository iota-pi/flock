import { createSyncBridge } from './SyncBridge'
import { clearAutomergeIndexedDb, clearAccountLocalData } from './localDataCleanup'
import * as Comlink from 'comlink'
import { getVaultStorageNames } from '../shared/storageNames'
import type { ItemId } from '@vault/shared'
import { createFakeSink, createFakeTelemetry } from './__test__/fakeHost'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { attemptSessionRecovery } from '../../api/sessionRecovery'
import { resumePendingReencryption } from '../../api/reencrypt'

vi.mock('../../api/vault', () => ({
  exportKeyringData: vi.fn().mockResolvedValue('test-key'),
  hasRandomDataKeys: vi.fn().mockReturnValue(false),
  reloadKeyringFromStorage: vi.fn().mockResolvedValue({ success: true, keyringData: 'reloaded-key' }),
  hasVaultKey: vi.fn().mockReturnValue(true),
  syncKeyringFromServer: vi.fn().mockResolvedValue(undefined),
  getVaultSession: vi.fn().mockReturnValue(null),
  handleSessionExpired: vi.fn().mockResolvedValue(undefined),
  getKeyHash: vi.fn().mockReturnValue(null),
  onLateSession: vi.fn().mockReturnValue(() => undefined),
}))

vi.mock('../../api/sessionRecovery', () => ({
  attemptSessionRecovery: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../api/reencrypt', () => ({
  resumePendingReencryption: vi.fn().mockResolvedValue(undefined),
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
  replaceFromServer: vi.fn().mockResolvedValue(undefined),
  forceOverwriteRecoveryItem: vi.fn().mockResolvedValue(undefined),
  forceDeleteRecoveryItem: vi.fn().mockResolvedValue(undefined),
  dismissRecoveryItem: vi.fn().mockResolvedValue(undefined),
  updateVaultKey: vi.fn().mockResolvedValue(undefined),
  updateAuthToken: vi.fn().mockResolvedValue(undefined),
  reencryptAllItems: vi.fn().mockResolvedValue({ succeeded: [], failed: [] }),
  flushSync: vi.fn().mockResolvedValue(undefined),
  pushSnapshots: vi.fn().mockResolvedValue({ persisted: 0, total: 0 }),
  retrySave: vi.fn().mockResolvedValue({ success: true }),
  claimLeader: vi.fn().mockResolvedValue(undefined),
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

const sink = createFakeSink()
const lockVault = vi.fn().mockResolvedValue(undefined)
// Workers are created through globalThis.Worker at call time, so tests can swap in their own mock
const SyncBridge = createSyncBridge({
  createWorker: () => new Worker('vault.worker.js', { type: 'module' }),
  sink,
  telemetry: createFakeTelemetry(),
  getAccountId: () => null,
  lockVault,
})

describe('SyncBridge', () => {
  let originalWorker: any

  beforeEach(() => {
    originalWorker = globalThis.Worker
    globalThis.Worker = MockWorker as any
    localStorage.setItem(getVaultStorageNames().vaultMetadataKey, JSON.stringify({ account: 'test-account', key: 'test-key' }))
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
    mockSyncApi.flushSync.mockResolvedValue(undefined)
    Object.assign(sink.state, { syncStatus: 'idle', fatalError: null, syncWarning: null })
  })

  afterEach(async () => {
    globalThis.Worker = originalWorker
    localStorage.clear()
    await SyncBridge.shutdown()
    vi.restoreAllMocks()
  })

  it('initializes and configures the sync worker', async () => {
    const initPromise = SyncBridge.initialize('test-account')
    expect(sink.state.syncStatus).toBe('connecting')
    await initPromise

    expect(Comlink.wrap).toHaveBeenCalled()
    expect(mockSyncApi.setOnlineState).toHaveBeenCalled()
    expect(mockSyncApi.initRepo).toHaveBeenCalledWith(
      'test-account',
      'test-key',
      undefined,
      { randomDataKeys: false },
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
    expect(sink.state.syncStatus).toBe('offline')

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
    expect(sink.state.syncStatus).toBe('connecting')
    expect(sink.state.syncWarning).toBe('Sync connection lost. Reconnecting...')

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

    // Move time forward by first timeout: HEARTBEAT_INTERVAL (15s) + HEARTBEAT_TIMEOUT (30s) = 45s
    await vi.advanceTimersByTimeAsync(45000)
    expect(sink.state.syncWarning).toBe('Sync connection is slow. Checking...')

    // Move time forward by second timeout: HEARTBEAT_INTERVAL (15s) + HEARTBEAT_TIMEOUT (30s) = 45s -> total 90s
    await vi.advanceTimersByTimeAsync(45000)

    expect(sink.state.syncStatus).toBe('connecting')
    expect(sink.state.syncWarning).toBe('Sync connection lost. Reconnecting...')

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
    expect(sink.state.fatalError).toBe('Sync worker crashed repeatedly. Please refresh the page to try again.')
    expect(sink.state.syncStatus).toBe('dead')
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

  describe('reconnect coordination', () => {
    it('coordinates session recovery, warning clearing, sync flush, and reencryption on reconnect', async () => {
      vi.mocked(attemptSessionRecovery).mockResolvedValue(true)
      vi.mocked(resumePendingReencryption).mockResolvedValue(undefined)
      const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)

      await SyncBridge.initialize('test-reconnect-account')
      Object.assign(sink.state, { syncWarning: 'Warning to be cleared' })
      vi.clearAllMocks()

      window.dispatchEvent(new Event('online'))

      await vi.waitFor(() => {
        expect(attemptSessionRecovery).toHaveBeenCalledWith('test-reconnect-account')
        expect(mockSyncApi.flushSync).toHaveBeenCalledTimes(1)
      })

      expect(sink.state.syncWarning).toBeNull()
      expect(resumePendingReencryption).toHaveBeenCalledWith(SyncBridge, 'test-reconnect-account')

      onLineSpy.mockRestore()
    })

    it('does not clear sync warning or flush sync when session recovery fails', async () => {
      vi.mocked(attemptSessionRecovery).mockResolvedValue(false)
      vi.mocked(resumePendingReencryption).mockResolvedValue(undefined)
      const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)

      await SyncBridge.initialize('test-failed-recovery-account')
      Object.assign(sink.state, { syncWarning: 'Persistent sync warning' })
      vi.clearAllMocks()

      window.dispatchEvent(new Event('online'))

      await vi.waitFor(() => {
        expect(attemptSessionRecovery).toHaveBeenCalledWith('test-failed-recovery-account')
        expect(resumePendingReencryption).toHaveBeenCalledWith(SyncBridge, 'test-failed-recovery-account')
      })

      expect(mockSyncApi.flushSync).not.toHaveBeenCalled()
      expect(sink.state.syncWarning).toBe('Persistent sync warning')

      onLineSpy.mockRestore()
    })

    it('does not trigger session recovery or flush on offline event', async () => {
      const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)

      await SyncBridge.initialize('test-offline-account')
      vi.clearAllMocks()

      window.dispatchEvent(new Event('offline'))

      await vi.waitFor(() => {
        expect(mockSyncApi.setOnlineState).toHaveBeenCalledWith(false)
      })

      expect(attemptSessionRecovery).not.toHaveBeenCalled()
      expect(mockSyncApi.flushSync).not.toHaveBeenCalled()
      expect(resumePendingReencryption).not.toHaveBeenCalled()

      onLineSpy.mockRestore()
    })

    it('aborts reconnect pipeline if network goes offline while attempting session recovery', async () => {
      let resolveRecovery!: (val: boolean) => void
      const recoveryPromise = new Promise<boolean>(resolve => {
        resolveRecovery = resolve
      })
      vi.mocked(attemptSessionRecovery).mockImplementation(() => recoveryPromise)
      vi.mocked(resumePendingReencryption).mockResolvedValue(undefined)

      const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
      await SyncBridge.initialize('test-abort-account')
      vi.clearAllMocks()

      window.dispatchEvent(new Event('online'))

      await vi.waitFor(() => {
        expect(attemptSessionRecovery).toHaveBeenCalledWith('test-abort-account')
      })

      // Network goes offline before session recovery finishes
      onLineSpy.mockReturnValue(false)
      window.dispatchEvent(new Event('offline'))

      // Resolve recovery now that we're offline
      resolveRecovery(true)

      // Microtasks delay
      await new Promise(r => setTimeout(r, 20))

      expect(mockSyncApi.flushSync).not.toHaveBeenCalled()
      expect(resumePendingReencryption).not.toHaveBeenCalled()

      onLineSpy.mockRestore()
    })
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
    const { reloadKeyringFromStorage } = await import('../../api/vault')
    vi.mocked(reloadKeyringFromStorage).mockResolvedValueOnce({
      success: true,
      keyringData: 'new-keyring-version-2',
    })

    await SyncBridge.initialize('test-account')

    const storageEvent = new StorageEvent('storage', {
      key: 'test-vault-keyring-cache',
    })
    window.dispatchEvent(storageEvent)

    await vi.waitFor(() => {
      expect(reloadKeyringFromStorage).toHaveBeenCalledWith()
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('new-keyring-version-2')
    })
  })

  it('locks vault when storage reload indicates passwordChanged', async () => {
    const { reloadKeyringFromStorage } = await import('../../api/vault')
    vi.mocked(reloadKeyringFromStorage).mockResolvedValueOnce({
      success: false,
      passwordChanged: true,
    })

    await SyncBridge.initialize('test-account')

    const storageEvent = new StorageEvent('storage', {
      key: 'test-vault-keyring-cache',
    })
    window.dispatchEvent(storageEvent)

    await vi.waitFor(() => {
      expect(lockVault).toHaveBeenCalled()
    })
  })

  it('reloads keyring and updates worker when keyVersionMissing event is received', async () => {
    const { reloadKeyringFromStorage } = await import('../../api/vault')
    vi.mocked(reloadKeyringFromStorage).mockResolvedValueOnce({
      success: true,
      keyringData: 'new-keyring-version-3',
    })

    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '3' })

    await vi.waitFor(() => {
      expect(reloadKeyringFromStorage).toHaveBeenCalledWith()
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('new-keyring-version-3')
    })
  })

  it('fetches keyring from server when keyVersionMissing references a key not in local storage', async () => {
    const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../../api/vault')
    vi.mocked(hasVaultKey).mockReturnValueOnce(false)
    vi.mocked(syncKeyringFromServer).mockResolvedValueOnce(true)
    vi.mocked(reloadKeyringFromStorage)
      .mockResolvedValueOnce({ success: true, keyringData: 'old-key' })
      .mockResolvedValueOnce({ success: true, keyringData: 'server-fetched-keyring-version-5' })

    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '5' })

    await vi.waitFor(() => {
      expect(syncKeyringFromServer).toHaveBeenCalledWith('test-account')
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('server-fetched-keyring-version-5')
    })
  })

  it('coalesces concurrent keyVersionMissing events to prevent duplicate server calls', async () => {
    const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../../api/vault')
    let serverSynced = false
    vi.mocked(hasVaultKey).mockImplementation(() => serverSynced)

    let resolveServerSync!: () => void
    const serverSyncPromise = new Promise<void>(resolve => {
      resolveServerSync = resolve
    })
    vi.mocked(syncKeyringFromServer).mockImplementation(async () => {
      await serverSyncPromise
      serverSynced = true
      return true
    })
    vi.mocked(reloadKeyringFromStorage).mockImplementation(async () => ({
      success: true,
      keyringData: serverSynced ? 'coalesced-keyring' : 'old-keyring',
    }))

    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '7' })
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '7' })
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '7' })

    await vi.waitFor(() => {
      expect(syncKeyringFromServer).toHaveBeenCalledTimes(1)
    })

    resolveServerSync()

    await vi.waitFor(() => {
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('coalesced-keyring')
    })

    expect(syncKeyringFromServer).toHaveBeenCalledTimes(1)

    vi.mocked(hasVaultKey).mockReturnValue(true)
    vi.mocked(syncKeyringFromServer).mockResolvedValue(true)
    vi.mocked(reloadKeyringFromStorage).mockResolvedValue({ success: true, keyringData: 'reloaded-key' })
  })

  it('coalesces concurrent keyVersionMissing events for different key versions into a single server call', async () => {
    const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../../api/vault')
    let serverSynced = false
    vi.mocked(hasVaultKey).mockImplementation(() => serverSynced)

    let resolveServerSync!: () => void
    const serverSyncPromise = new Promise<void>(resolve => {
      resolveServerSync = resolve
    })
    vi.mocked(syncKeyringFromServer).mockImplementation(async () => {
      await serverSyncPromise
      serverSynced = true
      return true
    })
    vi.mocked(reloadKeyringFromStorage).mockImplementation(async () => ({
      success: true,
      keyringData: serverSynced ? 'multi-key-keyring' : 'old-keyring',
    }))

    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '7' })
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '8' })

    await vi.waitFor(() => {
      expect(syncKeyringFromServer).toHaveBeenCalledTimes(1)
    })

    resolveServerSync()

    await vi.waitFor(() => {
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('multi-key-keyring')
    })

    expect(syncKeyringFromServer).toHaveBeenCalledTimes(1)

    vi.mocked(hasVaultKey).mockReturnValue(true)
    vi.mocked(syncKeyringFromServer).mockResolvedValue(true)
    vi.mocked(reloadKeyringFromStorage).mockResolvedValue({ success: true, keyringData: 'reloaded-key' })
  })

  it('handles network error gracefully without looping when syncing keyring from server', async () => {
    const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../../api/vault')
    vi.mocked(hasVaultKey).mockReturnValue(false)

    let rejectServerSync!: (err: Error) => void
    const serverSyncPromise = new Promise<void>((_, reject) => {
      rejectServerSync = reject
    })
    vi.mocked(syncKeyringFromServer).mockImplementation(async () => {
      await serverSyncPromise
      return true
    })
    vi.mocked(reloadKeyringFromStorage).mockResolvedValue({
      success: true,
      keyringData: 'fallback-local-keyring',
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '9' })
    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '9' })

    await vi.waitFor(() => {
      expect(syncKeyringFromServer).toHaveBeenCalledTimes(1)
    })

    rejectServerSync(new Error('Network offline'))

    await vi.waitFor(() => {
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('fallback-local-keyring')
    })

    expect(syncKeyringFromServer).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[SyncBridge] Failed to sync keyring from server:',
      expect.any(Error),
    )

    vi.mocked(hasVaultKey).mockReturnValue(true)
    vi.mocked(syncKeyringFromServer).mockResolvedValue(true)
    vi.mocked(reloadKeyringFromStorage).mockResolvedValue({ success: true, keyringData: 'reloaded-key' })
  })

  it('keeps a key version the server sync failed to fetch, retrying it at the next keyring update', async () => {
    const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../../api/vault')
    vi.mocked(hasVaultKey).mockReturnValue(false)
    vi.mocked(syncKeyringFromServer).mockRejectedValueOnce(new Error('Network offline'))
    vi.mocked(reloadKeyringFromStorage).mockResolvedValue({ success: true, keyringData: 'local-keyring' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await SyncBridge.initialize('test-account')

    lastEventPort!.postMessage({ type: 'keyVersionMissing', kver: '10' })
    await vi.waitFor(() => {
      expect(syncKeyringFromServer).toHaveBeenCalledTimes(1)
      expect(mockSyncApi.updateVaultKey).toHaveBeenCalledWith('local-keyring')
    })

    // A later keyring update without a version still looks for it
    vi.mocked(syncKeyringFromServer).mockResolvedValueOnce(true)
    window.dispatchEvent(new StorageEvent('storage', { key: 'test-vault-keyring-cache' }))
    await vi.waitFor(() => {
      expect(syncKeyringFromServer).toHaveBeenCalledTimes(2)
    })

    vi.mocked(hasVaultKey).mockReturnValue(true)
    vi.mocked(syncKeyringFromServer).mockResolvedValue(true)
    vi.mocked(reloadKeyringFromStorage).mockResolvedValue({ success: true, keyringData: 'reloaded-key' })
  })

  it('updates syncStatus to degraded and sets syncWarning when snapshotFailed event is received', async () => {
    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({
      type: 'snapshotFailed',
      itemId: 'item-1',
      message: 'Snapshot sync failed for item item-1: Document data not available. Changes are stored locally only.',
    })

    await vi.waitFor(() => {
      expect(sink.state.syncStatus).toBe('degraded')
      expect(sink.state.syncWarning).toBe(
        'Snapshot sync failed for item item-1: Document data not available. Changes are stored locally only.',
      )
    })
  })

  it('updates isQuotaExceeded on quotaExceeded event and clears on quotaResolved event', async () => {
    await SyncBridge.initialize('test-account')

    expect(lastEventPort).not.toBeNull()
    lastEventPort!.postMessage({
      type: 'quotaExceeded',
      message: 'Storage quota exceeded. Changes cannot be saved.',
    })

    await vi.waitFor(() => {
      expect(sink.state.syncStatus).toBe('degraded')
      expect(sink.state.isQuotaExceeded).toBe(true)
    })

    lastEventPort!.postMessage({
      type: 'quotaResolved',
    })

    await vi.waitFor(() => {
      expect(sink.state.isQuotaExceeded).toBe(false)
    })
  })

  it('delegates retrySave to syncApi', async () => {
    await SyncBridge.initialize('test-account')
    mockSyncApi.retrySave.mockResolvedValueOnce({ success: true })

    const res = await SyncBridge.retrySave()
    expect(mockSyncApi.retrySave).toHaveBeenCalled()
    expect(res).toEqual({ success: true })
  })

  it('handles leaderConflict events and updates store state', async () => {
    await SyncBridge.initialize('test-account')

    expect(sink.state.isLeaderConflict).toBe(false)

    // Simulate leaderConflict true event from worker
    lastEventPort!.postMessage({ type: 'leaderConflict', hasConflict: true })

    await vi.waitFor(() => {
      expect(sink.state.isLeaderConflict).toBe(true)
    })

    // Simulate leaderConflict false event from worker
    lastEventPort!.postMessage({ type: 'leaderConflict', hasConflict: false })

    await vi.waitFor(() => {
      expect(sink.state.isLeaderConflict).toBe(false)
    })
  })

  it('delegates claimLeader to syncApi', async () => {
    await SyncBridge.initialize('test-account')
    mockSyncApi.claimLeader.mockResolvedValueOnce(undefined)

    await SyncBridge.claimLeader()
    expect(mockSyncApi.claimLeader).toHaveBeenCalledTimes(1)
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
    expect(sink.state.syncStatus).not.toBe('offline')
  })

  it('resets initializationPromise when initialization is aborted due to concurrent account change', async () => {
    let resolveKeyring1: (val: string) => void = () => {}
    const { exportKeyringData } = await import('../../api/vault')
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

    const updateItemsSpy = sink.updateItems

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

  it('closes MessagePorts from globalEventChannel and pingChannel when initialization is aborted', async () => {
    const originalMessageChannel = globalThis.MessageChannel
    const channelCloseSpies: any[] = []
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
        channelCloseSpies.push(this.port1.close)
      }
    }
    globalThis.MessageChannel = MockMessageChannel as any

    try {
      let init1ResolveRepo: () => void = () => {}
      mockSyncApi.initRepo.mockImplementation((accountId: string) => {
        if (accountId === 'account-1') {
          return new Promise<void>(resolve => {
            init1ResolveRepo = resolve
          })
        }
        return Promise.resolve()
      })

      const init1Promise = SyncBridge.initialize('account-1')
      await new Promise(r => setTimeout(r, 10))

      // Session 1 channels have been created (globalEventChannel and pingChannel)
      expect(channelCloseSpies.length).toBe(2)
      expect(channelCloseSpies[0]).not.toHaveBeenCalled()
      expect(channelCloseSpies[1]).not.toHaveBeenCalled()

      // Concurrently start session 2, which supersedes session 1
      const init2Promise = SyncBridge.initialize('account-2')
      await new Promise(r => setTimeout(r, 10))

      // Now complete initRepo for account-1 so it reaches the abort check
      init1ResolveRepo()
      await init1Promise
      await init2Promise

      // Session 1's ports (indices 0 and 1) must be closed because initialization aborted
      expect(channelCloseSpies[0]).toHaveBeenCalled()
      expect(channelCloseSpies[1]).toHaveBeenCalled()

      // Session 2's ports (indices 2 and 3) must remain open
      expect(channelCloseSpies.length).toBe(4)
      expect(channelCloseSpies[2]).not.toHaveBeenCalled()
      expect(channelCloseSpies[3]).not.toHaveBeenCalled()
    } finally {
      globalThis.MessageChannel = originalMessageChannel
    }
  })

  it('does not close newer session MessagePorts in catch block if superseded by another init session', async () => {
    const originalMessageChannel = globalThis.MessageChannel
    const channelCloseSpies: any[] = []
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
        channelCloseSpies.push(this.port1.close)
      }
    }
    globalThis.MessageChannel = MockMessageChannel as any

    try {
      let init1RejectRepo: (err: Error) => void = () => {}
      mockSyncApi.initRepo.mockImplementation((accountId: string) => {
        if (accountId === 'account-fail') {
          return new Promise<void>((_, reject) => {
            init1RejectRepo = reject
          })
        }
        return Promise.resolve()
      })

      const init1Promise = SyncBridge.initialize('account-fail')
      await new Promise(r => setTimeout(r, 10))

      // Session 1 has created 2 channels
      expect(channelCloseSpies.length).toBe(2)

      // Session 2 starts and initializes successfully with account-success
      const init2Promise = SyncBridge.initialize('account-success')
      await init2Promise

      // Session 2 created 2 new channels (indices 2 and 3)
      expect(channelCloseSpies.length).toBe(4)
      expect(channelCloseSpies[2]).not.toHaveBeenCalled()
      expect(channelCloseSpies[3]).not.toHaveBeenCalled()

      // Session 2 superseded session 1 and shut its worker down, so session 1 gives up quietly,
      // even when its initRepo fails later
      await expect(init1Promise).resolves.toBeUndefined()
      init1RejectRepo(new Error('Init 1 failed'))
      await new Promise(r => setTimeout(r, 10))

      // Session 1's own ports should be closed
      expect(channelCloseSpies[0]).toHaveBeenCalled()
      expect(channelCloseSpies[1]).toHaveBeenCalled()

      // Session 2's ports must NOT have been closed by session 1
      expect(channelCloseSpies[2]).not.toHaveBeenCalled()
      expect(channelCloseSpies[3]).not.toHaveBeenCalled()

      // And ensureReady should succeed because session 2 is active
      await expect(SyncBridge.ensureReady()).resolves.toBeUndefined()
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
    expect(sink.state.syncWarning).toBe('Sync initialization failed. Retrying in 2s...')

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
    expect(sink.state.syncWarning).toBeNull()

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

    expect(sink.state.fatalError).toBe('Unable to start sync. Please refresh the page.')
    expect(sink.state.syncStatus).toBe('offline')

    vi.useRealTimers()
  })

  it('cancels retry when account changes during retry delay', async () => {
    vi.useFakeTimers()
    mockSyncApi.initRepo.mockRejectedValueOnce(new Error('account 1 failed'))

    await expect(SyncBridge.initialize('account-fail')).rejects.toThrow('account 1 failed')
    expect(sink.state.syncWarning).toBe('Sync initialization failed. Retrying in 2s...')

    // Switch account before retry timer fires
    const initTwo = SyncBridge.initialize('account-success')
    await initTwo

    // Advance timer for old retry
    await vi.advanceTimersByTimeAsync(2000)

    // Should be initialized with account-success, not failed account
    expect(mockSyncApi.initRepo).toHaveBeenLastCalledWith(
      'account-success',
      'test-key',
      undefined,
      { randomDataKeys: false },
    )

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

    const { exportKeyringData } = await import('../../api/vault')
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

    await SyncBridge.shutdown({ internalRestart: true })

    // Listener shouldn't have been called with empty array upon shutdown
    expect(recoveryListener).toHaveBeenCalledTimes(1)
    // App store state shouldn't be reset
    expect(sink.reset).not.toHaveBeenCalled()
  })

  describe('local data that cannot be opened', () => {
    it('reloads a missing key from the server the first time, and hands over to the app the second', async () => {
      const { syncKeyringFromServer, hasVaultKey } = await import('../../api/vault')
      vi.mocked(hasVaultKey).mockReturnValue(false)
      await SyncBridge.initialize('test-account')

      lastEventPort!.postMessage({ type: 'localDataUnavailable', kver: '3', unpushedChanges: 2 })
      await vi.waitFor(() => {
        expect(syncKeyringFromServer).toHaveBeenCalledWith('test-account')
      })
      expect(sink.onLocalDataUnavailable).not.toHaveBeenCalled()

      lastEventPort!.postMessage({ type: 'localDataUnavailable', kver: '3', unpushedChanges: 2 })
      await vi.waitFor(() => {
        expect(sink.onLocalDataUnavailable).toHaveBeenCalledWith({ unpushedChanges: 2 })
      })
      expect(mockSyncApi.shutdown).toHaveBeenCalled()
      vi.mocked(hasVaultKey).mockReturnValue(true)
    })

    it('does not fetch the keyring when the key is already loaded', async () => {
      const { syncKeyringFromServer, hasVaultKey } = await import('../../api/vault')
      vi.mocked(hasVaultKey).mockReturnValue(true)
      await SyncBridge.initialize('test-account')

      lastEventPort!.postMessage({ type: 'localDataUnavailable', unpushedChanges: 0 })
      await new Promise(resolve => setTimeout(resolve, 10))

      expect(syncKeyringFromServer).not.toHaveBeenCalled()
      expect(sink.onLocalDataUnavailable).not.toHaveBeenCalled()
    })

    it('discards the local data and starts again when asked', async () => {
      await SyncBridge.initialize('test-account')
      mockSyncApi.initRepo.mockClear()

      await SyncBridge.discardLocalDataAndRestart('test-account')

      expect(mockSyncApi.shutdown).toHaveBeenCalled()
      expect(mockSyncApi.initRepo).toHaveBeenCalledTimes(1)
    })

    it('passes a request to stop other tabs to the app', async () => {
      await SyncBridge.initialize('test-account')

      lastEventPort!.postMessage({ type: 'retiringLegacyStores', accountId: 'test-account' })

      await vi.waitFor(() => {
        expect(sink.beforeRetiringLegacyStores).toHaveBeenCalledWith('test-account')
      })
    })
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

      const person = { id: 'item-2' as ItemId, name: 'Person 2' }
      const person3 = { id: 'item-3' as ItemId, name: 'Person 3' }

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

      await SyncBridge.replaceFromServer('item-1' as ItemId)
      expect(mockSyncApi.replaceFromServer).toHaveBeenCalledWith('item-1')

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

      const incrementSpy = sink.onDataRestored
      const restoreResult = await SyncBridge.restoreFromBinaries({ doc1: 'data' })
      expect(mockSyncApi.restoreFromBinaries).toHaveBeenCalledWith({ doc1: 'data' })
      expect(incrementSpy).toHaveBeenCalledTimes(1)
      expect(restoreResult).toEqual(['doc-1'])

      const onProgress = vi.fn()
      await SyncBridge.reencryptAllItems(onProgress)
      expect(mockSyncApi.reencryptAllItems).toHaveBeenCalledTimes(1)

      const entries: ManualRecoveryEntry[] = [
        {
          id: 'rec-1',
          itemId: 'item-1' as ItemId,
          reason: 'invalid document',
          kind: 'pullDecryption',
          createdAt: 123456,
        },
      ]
      mockSyncApi.listRecoveryItems.mockResolvedValueOnce(entries)
      const listResult = await SyncBridge.listRecoveryItems()
      expect(listResult).toEqual(entries)
    })

    it('clears local data when shutdown({ clearLocalData: true }) is called after syncApi is already null', async () => {
      await SyncBridge.initialize('test-account-cleared')
      // Simulate unmount shutdown without args
      await SyncBridge.shutdown()

      // Now explicit logout occurs when syncApi is null
      await expect(SyncBridge.shutdown({ clearLocalData: true, accountId: 'test-account-cleared' })).resolves.not.toThrow()
    })

    it('preserves clearLocalData instruction when concurrent shutdown() is followed by shutdown({ clearLocalData: true })', async () => {
      const { SyncWriteAheadLog } = await import('../worker/SyncWriteAheadLog')
      const walClearSpy = vi.spyOn(SyncWriteAheadLog, 'clearSealed')

      await SyncBridge.initialize('test-account-race-1')

      let resolveShutdown: () => void = () => {}
      mockSyncApi.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveShutdown = resolve
      }))

      // Unmount starts shutdown without clearLocalData
      const unmountShutdown = SyncBridge.shutdown()

      // Logout thunk immediately calls shutdown with clearLocalData: true
      const logoutShutdown = SyncBridge.shutdown({ clearLocalData: true, accountId: 'test-account-race-1' })

      resolveShutdown()
      await unmountShutdown
      await logoutShutdown

      expect(walClearSpy).toHaveBeenCalledWith('test-account-race-1')
      expect(SyncBridge.isClearingLocalData()).toBe(false)
      walClearSpy.mockRestore()
    })

    it('preserves clearLocalData instruction when shutdown({ clearLocalData: true }) is followed by unmount shutdown()', async () => {
      await SyncBridge.initialize('test-account-race-2')

      let resolveShutdown: () => void = () => {}
      mockSyncApi.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveShutdown = resolve
      }))

      // Logout thunk starts shutdown with clearLocalData: true
      const logoutShutdown = SyncBridge.shutdown({ clearLocalData: true, accountId: 'test-account-race-2' })

      // Unmount effect fires shutdown without args while logout is in-flight
      const unmountShutdown = SyncBridge.shutdown()

      resolveShutdown()
      await logoutShutdown
      await unmountShutdown

      expect(mockSyncApi.shutdown).toHaveBeenCalledWith(
        expect.objectContaining({ clearLocalData: true })
      )
    })

    it('executes clearLocalData if requestClearOnShutdown was called before unmount shutdown', async () => {
      await SyncBridge.initialize('test-account-preempt')

      SyncBridge.requestClearOnShutdown('test-account-preempt')
      expect(SyncBridge.isClearingLocalData()).toBe(true)

      await SyncBridge.shutdown()

      expect(mockSyncApi.shutdown).toHaveBeenCalledWith(
        expect.objectContaining({ clearLocalData: true })
      )
      expect(SyncBridge.isClearingLocalData()).toBe(false)
    })

  })

  describe('clearAutomergeIndexedDb', () => {
    const originalIndexedDB = globalThis.indexedDB
    let mockReq: {
      onsuccess: ((event?: any) => void) | null
      onerror: ((event?: any) => void) | null
      onblocked: ((event?: any) => void) | null
      error?: Error | null
    }

    beforeEach(() => {
      mockReq = {
        onsuccess: null,
        onerror: null,
        onblocked: null,
        error: null,
      }
      globalThis.indexedDB = {
        deleteDatabase: vi.fn().mockImplementation(() => mockReq),
      } as any
    })

    afterEach(() => {
      globalThis.indexedDB = originalIndexedDB
      vi.useRealTimers()
    })

    it('resolves when deleteDatabase succeeds immediately', async () => {
      const clearPromise = clearAutomergeIndexedDb('automerge-db-acc-1')
      expect(globalThis.indexedDB.deleteDatabase).toHaveBeenCalledWith('automerge-db-acc-1')
      mockReq.onsuccess?.()
      await expect(clearPromise).resolves.toBeUndefined()
    })

    it('does NOT resolve when onblocked fires; waits for onsuccess and resolves when unblocked', async () => {
      let resolved = false
      const clearPromise = clearAutomergeIndexedDb('acc-1').then(() => {
        resolved = true
      })

      // Simulate blocked event (e.g. open connections)
      mockReq.onblocked?.()

      // Must NOT have resolved yet
      await new Promise(r => setTimeout(r, 10))
      expect(resolved).toBe(false)

      // Simulate connection closing and deletion completing
      mockReq.onsuccess?.()
      await clearPromise
      expect(resolved).toBe(true)
    })

    it('rejects when blocked and timeout expires', async () => {
      vi.useFakeTimers()
      const clearPromise = clearAutomergeIndexedDb('acc-1', 1000)

      mockReq.onblocked?.()

      // Advance time past timeout
      vi.advanceTimersByTime(1000)

      await expect(clearPromise).rejects.toThrow(/deleteDatabase blocked and timed out after 1000ms/)
    })

    it('rejects when timeout expires without blocked event', async () => {
      vi.useFakeTimers()
      const clearPromise = clearAutomergeIndexedDb('acc-1', 1000)

      // Advance time past timeout without any event
      vi.advanceTimersByTime(1000)

      await expect(clearPromise).rejects.toThrow(/deleteDatabase timed out after 1000ms/)
    })

    it('rejects when onerror is fired', async () => {
      const clearPromise = clearAutomergeIndexedDb('acc-1')
      mockReq.error = new Error('IDB delete failed')
      mockReq.onerror?.()

      await expect(clearPromise).rejects.toThrow('IDB delete failed')
    })

    it('resolves immediately when indexedDB is undefined', async () => {
      globalThis.indexedDB = undefined as any
      await expect(clearAutomergeIndexedDb('acc-1')).resolves.toBeUndefined()
    })

    it('clearAccountLocalData catches rejection from clearAutomergeIndexedDb gracefully', async () => {
      vi.useFakeTimers()
      const clearPromise = clearAccountLocalData('acc-1')

      mockReq.onblocked?.()
      vi.advanceTimersByTime(5000)

      // clearAccountLocalData uses Promise.allSettled and does not throw uncaught error
      await expect(clearPromise).resolves.toBeUndefined()
    })

    it('clearAccountLocalData deletes both the plaintext and sealed Automerge databases', async () => {
      globalThis.indexedDB = {
        deleteDatabase: vi.fn().mockImplementation(() => {
          const req: typeof mockReq = { onsuccess: null, onerror: null, onblocked: null }
          setTimeout(() => req.onsuccess?.(), 0)
          return req
        }),
      } as any
      await clearAccountLocalData('acc-1')
      expect(globalThis.indexedDB.deleteDatabase).toHaveBeenCalledWith('test-vault-automerge-acc-1')
      expect(globalThis.indexedDB.deleteDatabase).toHaveBeenCalledWith('test-vault-automerge-sealed-acc-1')
    })
  })
})

