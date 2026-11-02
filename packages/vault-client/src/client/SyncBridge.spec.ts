import { createSyncBridge } from './SyncBridge'
import * as Comlink from 'comlink'
import { getVaultStorageNames } from '../shared/storageNames'
import type { ItemId } from '@vault/shared'
import { createFakeSink, createFakeTelemetry } from './__test__/fakeHost'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { attemptSessionRecovery } from '../keys/sessionRecovery'
import { resumePendingReencryption } from '../keys/reencrypt'
import * as vaultModule from '../keys/vault'
import * as sessionModule from '../keys/session'
import * as storedMetadataModule from '../keys/storedMetadata'
import * as sessionRecoveryModule from '../keys/sessionRecovery'
import * as reencryptModule from '../keys/reencrypt'
import { spyOnExports } from '../../test/moduleMocks'

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

/** Lets every pending promise callback run, for checking that something has not happened */
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))
const lockVault = vi.fn().mockResolvedValue(undefined)
// Workers are created through globalThis.Worker at call time, so tests can swap in their own mock
const SyncBridge = createSyncBridge({
  createWorker: () => new Worker('vault.worker.js', { type: 'module' }),
  sink,
  telemetry: createFakeTelemetry(),
  getAccountId: () => null,
  lockVault,
})

beforeEach(() => {
  spyOnExports(vaultModule, {
    exportKeyringData: vi.fn().mockResolvedValue('test-key'),
    reloadKeyringFromStorage: vi.fn().mockResolvedValue({ success: true, keyringData: 'reloaded-key' }),
    hasVaultKey: vi.fn().mockReturnValue(true),
    syncKeyringFromServer: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(sessionModule, {
    getVaultSession: vi.fn().mockReturnValue(null),
    handleSessionExpired: vi.fn().mockResolvedValue(undefined),
    getKeyHash: vi.fn().mockReturnValue(null),
    onLateSession: vi.fn().mockReturnValue(() => undefined),
  })
  spyOnExports(storedMetadataModule, {
    hasRandomDataKeys: vi.fn().mockReturnValue(false),
  })
  spyOnExports(sessionRecoveryModule, {
    attemptSessionRecovery: vi.fn().mockResolvedValue(true),
  })
  spyOnExports(reencryptModule, {
    resumePendingReencryption: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(Comlink, {
    wrap: vi.fn(() => mockSyncApi),
    proxy: vi.fn(cb => cb),
  })
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

      await flushPromises()

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

  describe('keyring updates', () => {
    it('reloads keyring and updates worker on storage event for KEYRING_CACHE_KEY', async () => {
      const { reloadKeyringFromStorage } = await import('../keys/vault')
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
      const { reloadKeyringFromStorage } = await import('../keys/vault')
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
      const { reloadKeyringFromStorage } = await import('../keys/vault')
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
      const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../keys/vault')
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
      const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../keys/vault')
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
      const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../keys/vault')
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
      const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../keys/vault')
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
      const { reloadKeyringFromStorage, syncKeyringFromServer, hasVaultKey } = await import('../keys/vault')
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
  })

  it('delegates retrySave to syncApi', async () => {
    await SyncBridge.initialize('test-account')
    mockSyncApi.retrySave.mockResolvedValueOnce({ success: true })

    const res = await SyncBridge.retrySave()
    expect(mockSyncApi.retrySave).toHaveBeenCalled()
    expect(res).toEqual({ success: true })
  })

  it('delegates claimLeader to syncApi', async () => {
    await SyncBridge.initialize('test-account')
    mockSyncApi.claimLeader.mockResolvedValueOnce(undefined)

    await SyncBridge.claimLeader()
    expect(mockSyncApi.claimLeader).toHaveBeenCalledTimes(1)
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

    await vi.waitFor(() => {
      expect(updateItemsSpy).toHaveBeenCalledWith([
        { id: 'item-1', item: expect.objectContaining({ id: 'item-1', name: 'Test Item' }) },
      ])
    })
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
      const { syncKeyringFromServer, hasVaultKey } = await import('../keys/vault')
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
      const { syncKeyringFromServer, hasVaultKey } = await import('../keys/vault')
      vi.mocked(hasVaultKey).mockReturnValue(true)
      await SyncBridge.initialize('test-account')

      lastEventPort!.postMessage({ type: 'localDataUnavailable', unpushedChanges: 0 })
      // Events arrive in order, so once a later one is handled this one has been too
      lastEventPort!.postMessage({ type: 'retiringLegacyStores', accountId: 'test-account' })
      await vi.waitFor(() => expect(sink.beforeRetiringLegacyStores).toHaveBeenCalled())

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
  })
})

