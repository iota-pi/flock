import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as Comlink from 'comlink'
import { WorkerLifecycleManager, WorkerLifecycleCallbacks } from './WorkerLifecycleManager'
import * as localDataCleanup from './localDataCleanup'

const mockSyncApi = {
  setOnlineState: vi.fn().mockResolvedValue(undefined),
  initRepo: vi.fn().mockResolvedValue(undefined),
  bootstrapItems: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
}

vi.mock('comlink', () => ({
  wrap: vi.fn(() => mockSyncApi),
  proxy: vi.fn(cb => cb),
}))

vi.mock('src/api/vault', () => ({
  exportKeyringData: vi.fn().mockResolvedValue('test-key'),
  handleSessionExpired: vi.fn().mockResolvedValue(undefined),
  getVaultSession: vi.fn().mockReturnValue(null),
}))

class MockWorker {
  url: string
  options: any
  terminate = vi.fn()
  postMessage = vi.fn((data: any) => {
    if (data?.type === 'INIT_PING_PORT' && data.port) {
      const port = data.port
      port.postMessage?.('pong')
      port.onmessage?.({ data: 'ping' })
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

describe('WorkerLifecycleManager', () => {
  let originalWorker: any
  let callbacks: WorkerLifecycleCallbacks
  let manager: WorkerLifecycleManager
  let clearAccountLocalDataSpy: any

  beforeEach(() => {
    originalWorker = globalThis.Worker
    globalThis.Worker = MockWorker as any
    vi.clearAllMocks()

    mockSyncApi.setOnlineState.mockResolvedValue(undefined)
    mockSyncApi.initRepo.mockResolvedValue(undefined)
    mockSyncApi.bootstrapItems.mockResolvedValue(undefined)
    mockSyncApi.shutdown.mockResolvedValue(undefined)

    clearAccountLocalDataSpy = vi.spyOn(localDataCleanup, 'clearAccountLocalData').mockResolvedValue(undefined)

    callbacks = {
      onEvent: vi.fn(),
      onReady: vi.fn(),
      onRestart: vi.fn().mockResolvedValue(undefined),
      onShutdownCleanup: vi.fn(),
      onStatusChange: vi.fn(),
      onSyncWarning: vi.fn(),
      onFatalError: vi.fn(),
      getAccountId: vi.fn().mockReturnValue('mock-account'),
    }

    manager = new WorkerLifecycleManager(callbacks)
  })

  afterEach(async () => {
    globalThis.Worker = originalWorker
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  describe('Decoupling from Zustand (onStatusChange & callback events)', () => {
    it('notifies status change to connecting on init and invokes onReady on completion without touching Zustand', async () => {
      await manager.initialize('acc-test-1')

      expect(callbacks.onStatusChange).toHaveBeenCalledWith('connecting')
      expect(callbacks.onReady).toHaveBeenCalledTimes(1)
      expect(callbacks.onSyncWarning).toHaveBeenCalledWith(null)
      expect(manager.getSyncApi()).not.toBeNull()
      expect(manager.getCurrentAccountId()).toBe('acc-test-1')
    })

    it('notifies status change to offline on shutdown', async () => {
      await manager.initialize('acc-test-1')
      expect(callbacks.onStatusChange).toHaveBeenCalledWith('connecting')

      await manager.shutdown()
      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('offline')
      expect(callbacks.onShutdownCleanup).toHaveBeenCalled()
      expect(manager.getSyncApi()).toBeNull()
      expect(manager.getCurrentAccountId()).toBeNull()
    })

    it('surfaces fatal error and offline status via callbacks when retries are exhausted', async () => {
      vi.useFakeTimers()
      mockSyncApi.initRepo.mockRejectedValue(new Error('Persistent init failure'))

      // Initial call rejects
      await expect(manager.initialize('acc-fail')).rejects.toThrow('Persistent init failure')

      // Advance through all 5 retry backoff intervals
      for (let i = 0; i < 5; i++) {
        expect(callbacks.onSyncWarning).toHaveBeenCalledWith(expect.stringContaining('Sync initialization failed. Retrying in'))
        await vi.runOnlyPendingTimersAsync()
      }

      expect(callbacks.onFatalError).toHaveBeenCalledWith('Unable to start sync. Please refresh the page.')
      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('offline')
      expect(manager.getCurrentAccountId()).toBeNull()

      vi.useRealTimers()
    })
  })

  describe('Explicit clearLocalData Parameter (No Ambient State Leaks)', () => {
    it('clears account local data when clearLocalData: true is passed to initialize', async () => {
      await manager.initialize('account-with-clear', { clearLocalData: true })

      expect(clearAccountLocalDataSpy).toHaveBeenCalledWith('account-with-clear')
    })

    it('clears account local data when clearLocalData: true is passed to init()', async () => {
      await manager.init('account-via-init', { clearLocalData: true })

      expect(clearAccountLocalDataSpy).toHaveBeenCalledWith('account-via-init')
    })

    it('does NOT clear local data for subsequent accounts when clearLocalData is not passed', async () => {
      // First account initializes with clearLocalData: true
      await manager.initialize('account-one', { clearLocalData: true })
      expect(clearAccountLocalDataSpy).toHaveBeenCalledWith('account-one')
      clearAccountLocalDataSpy.mockClear()

      // Shutdown first account
      await manager.shutdown({ accountId: 'account-one' })

      // Second account initializes normally
      await manager.initialize('account-two')

      // Must not leak clearLocalData to account-two
      expect(clearAccountLocalDataSpy).not.toHaveBeenCalledWith('account-two')
      expect(manager.isClearingLocalData('account-two')).toBe(false)
    })

    it('clears local data if worker was running during initialize({ clearLocalData: true })', async () => {
      await manager.initialize('account-running')
      clearAccountLocalDataSpy.mockClear()

      // Re-initialize with clearLocalData: true
      await manager.initialize('account-running', { clearLocalData: true })
      expect(mockSyncApi.shutdown).toHaveBeenCalledWith(expect.objectContaining({ clearLocalData: true }))
      expect(clearAccountLocalDataSpy).toHaveBeenCalledWith('account-running')
    })

    it('tracks pending shutdown clear per account without leaking ambient boolean', async () => {
      manager.requestClearOnShutdown('acc-preempt')
      expect(manager.isClearingLocalData('acc-preempt')).toBe(true)
      expect(manager.isClearingLocalData('other-acc')).toBe(false)

      await manager.shutdown({ accountId: 'acc-preempt' })

      expect(clearAccountLocalDataSpy).toHaveBeenCalledWith('acc-preempt')
      expect(manager.isClearingLocalData('acc-preempt')).toBe(false)
    })
  })

  describe('AbortController Initialization Cancellation', () => {
    it('aborts previous initialization when a new initialization starts concurrently', async () => {
      let resolveInit1: () => void = () => {}
      mockSyncApi.initRepo.mockImplementation((accountId: string) => {
        if (accountId === 'session-1') {
          return new Promise<void>(resolve => {
            resolveInit1 = resolve
          })
        }
        return Promise.resolve()
      })

      // Start session 1
      const session1Promise = manager.initialize('session-1')
      await new Promise(r => setTimeout(r, 10))

      // Start session 2 concurrently (should abort session 1)
      const session2Promise = manager.initialize('session-2')

      // Complete session 1's initRepo
      resolveInit1()
      await session1Promise
      await session2Promise

      // Session 2 should be the active account
      expect(manager.getCurrentAccountId()).toBe('session-2')
      expect(manager.getSyncApi()).not.toBeNull()
    })

    it('aborts in-flight initialization when shutdown is invoked', async () => {
      let resolveInit: () => void = () => {}
      mockSyncApi.initRepo.mockImplementation(() => new Promise<void>(resolve => {
        resolveInit = resolve
      }))

      const initPromise = manager.initialize('abort-account')
      await new Promise(r => setTimeout(r, 10))

      // Invoke shutdown while initRepo is in-flight
      const shutdownPromise = manager.shutdown()

      resolveInit()
      await initPromise
      await shutdownPromise

      expect(manager.getCurrentAccountId()).toBeNull()
      expect(manager.getSyncApi()).toBeNull()
      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('offline')
    })

    it('cancels scheduled retry when new initialization is triggered', async () => {
      vi.useFakeTimers()
      mockSyncApi.initRepo.mockRejectedValueOnce(new Error('Fail first'))

      await expect(manager.initialize('account-retry-fail')).rejects.toThrow('Fail first')
      expect(callbacks.onSyncWarning).toHaveBeenCalledWith(expect.stringContaining('Retrying in'))

      // Switch account before retry timer elapses
      const newInitPromise = manager.initialize('account-new-success')
      await newInitPromise

      // Advance retry timer from first account
      await vi.runOnlyPendingTimersAsync()

      // The new account should remain active and not be clobbered
      expect(manager.getCurrentAccountId()).toBe('account-new-success')
      expect(mockSyncApi.initRepo).toHaveBeenLastCalledWith('account-new-success', 'test-key', expect.any(Function))

      vi.useRealTimers()
    })
  })
})
