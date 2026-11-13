import { WorkerLifecycleManager, type WorkerLifecycleCallbacks } from './WorkerLifecycleManager'
import type { ItemId } from '@vault/shared'
import * as localDataCleanup from './localDataCleanup'
import * as vaultModule from '../keys/vault'
import * as sessionModule from '../keys/session'
import * as storedMetadataModule from '../keys/storedMetadata'
import { spyOnExports } from '../../test/moduleMocks'
import * as comlinkModule from 'comlink'

const mockSyncApi = {
  setOnlineState: vi.fn().mockResolvedValue(undefined),
  initRepo: vi.fn().mockResolvedValue(undefined),
  updateAuthToken: vi.fn().mockResolvedValue(undefined),
  bootstrapItems: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
  mutateItem: vi.fn().mockResolvedValue(undefined),
}

/** Lets every pending promise callback run, for checking that something has not happened */
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

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

beforeEach(() => {
  spyOnExports(comlinkModule, {
    wrap: vi.fn(() => mockSyncApi),
    proxy: vi.fn(cb => cb),
  })
  spyOnExports(vaultModule, {
    exportKeyringData: vi.fn().mockResolvedValue('test-key'),
  })
  spyOnExports(sessionModule, {
    handleSessionExpired: vi.fn().mockResolvedValue(undefined),
    getVaultSession: vi.fn().mockReturnValue(null),
  })
  spyOnExports(storedMetadataModule, {
  })
})

describe('WorkerLifecycleManager', () => {
  let callbacks: WorkerLifecycleCallbacks
  let manager: WorkerLifecycleManager
  let clearAccountLocalDataSpy: any
  /** The workers created so far, oldest first */
  let workers: MockWorker[]

  beforeEach(() => {
    vi.clearAllMocks()

    mockSyncApi.setOnlineState.mockResolvedValue(undefined)
    mockSyncApi.initRepo.mockResolvedValue(undefined)
    mockSyncApi.bootstrapItems.mockResolvedValue(undefined)
    mockSyncApi.shutdown.mockResolvedValue(undefined)

    clearAccountLocalDataSpy = vi.spyOn(localDataCleanup, 'clearAccountLocalData').mockResolvedValue(undefined)

    workers = []
    callbacks = {
      createWorker: () => {
        const worker = new MockWorker('vault.worker.js', { type: 'module' })
        workers.push(worker)
        return worker as unknown as Worker
      },
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

    it("shuts down a worker that is still initializing and doesn't wait for its calls to return", async () => {
      // Calls to a terminated worker never settle
      mockSyncApi.bootstrapItems.mockImplementation(() => new Promise<void>(() => {}))

      const initPromise = manager.initialize('first-sync-account')
      await new Promise(r => setTimeout(r, 10))
      expect(mockSyncApi.bootstrapItems).toHaveBeenCalled()

      await manager.shutdown()
      await initPromise

      expect(mockSyncApi.shutdown).toHaveBeenCalledTimes(1)
      expect(manager.getSyncApi()).toBeNull()
      await expect(manager.ensureReady()).rejects.toThrow('SyncBridge not initialized')
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
      expect(mockSyncApi.initRepo).toHaveBeenLastCalledWith('account-new-success', 'test-key', { authToken: null })

      vi.useRealTimers()
    })

    it('logs initialization failure with [WorkerLifecycleManager] tag', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const initError = new Error('Init crash')
      mockSyncApi.initRepo.mockRejectedValueOnce(initError)

      await expect(manager.initialize('account-log-fail')).rejects.toThrow(initError)

      expect(errorSpy).toHaveBeenCalledWith(
        '[WorkerLifecycleManager] Failed to initialize SyncBridge:',
        initError
      )
      errorSpy.mockRestore()
    })
  })

  describe('starting and stopping workers', () => {
    it('initializes and configures the sync worker', async () => {
      vi.mocked(sessionModule.getVaultSession).mockReturnValueOnce('session-1')
      const initPromise = manager.initialize('test-account')
      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('connecting')
      await initPromise

      expect(comlinkModule.wrap).toHaveBeenCalled()
      expect(mockSyncApi.setOnlineState).toHaveBeenCalled()
      expect(mockSyncApi.initRepo).toHaveBeenCalledWith(
        'test-account',
        'test-key',
        // The session goes to the worker in memory, so it can sync before updateAuthToken
        { authToken: 'session-1' },
      )
      expect(mockSyncApi.bootstrapItems).toHaveBeenCalled()
    })

    it('returns early and does not create a new worker if already initialized with the same account', async () => {
      await manager.initialize('test-account')
      expect(comlinkModule.wrap).toHaveBeenCalledTimes(1)

      // Call initialize again with the same account
      await manager.initialize('test-account')
      expect(comlinkModule.wrap).toHaveBeenCalledTimes(1)
    })

    it('terminates the active worker and initializes a new one when initialized with a different account', async () => {
      await manager.initialize('account-one')
      expect(comlinkModule.wrap).toHaveBeenCalledTimes(1)
      expect(workers[0].terminate).not.toHaveBeenCalled()

      // Call initialize again with a different account
      await manager.initialize('account-two')
      expect(workers[0].terminate).toHaveBeenCalledTimes(1)
      expect(comlinkModule.wrap).toHaveBeenCalledTimes(2)
      expect(workers[1].terminate).not.toHaveBeenCalled()
    })

    it('terminates the active worker and resets state on shutdown', async () => {
      await manager.initialize('test-account')
      expect(workers[0].terminate).not.toHaveBeenCalled()

      await manager.shutdown()
      expect(mockSyncApi.shutdown).toHaveBeenCalledTimes(1)
      expect(workers[0].terminate).toHaveBeenCalledTimes(1)
      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('offline')

      // After shutdown, we should be able to initialize again (which spins up a new worker)
      await manager.initialize('test-account')
      expect(comlinkModule.wrap).toHaveBeenCalledTimes(2)
    })

    it('does not terminate a new worker if initialize() is called concurrently while shutdown() is awaiting worker shutdown', async () => {
      await manager.initialize('test-account')
      expect(workers).toHaveLength(1)

      let resolveShutdown: () => void = () => {}
      mockSyncApi.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveShutdown = resolve
      }))

      const shutdownPromise = manager.shutdown()
      const initPromise = manager.initialize('test-account-2')

      resolveShutdown()
      await shutdownPromise
      await initPromise

      expect(workers[0].terminate).toHaveBeenCalledTimes(1)
      expect(workers[1].terminate).not.toHaveBeenCalled()
      expect(callbacks.onStatusChange).not.toHaveBeenLastCalledWith('offline')
    })

    it('resets initializationPromise when initialization is aborted due to concurrent account change', async () => {
      let resolveKeyring1: (val: string) => void = () => {}
      vi.mocked(vaultModule.exportKeyringData).mockImplementationOnce(
        () => new Promise<string>(resolve => { resolveKeyring1 = resolve }),
      )

      const init1 = manager.initialize('account-1')
      const init2 = manager.initialize('account-2')

      resolveKeyring1('test-key')
      await init1
      await init2

      // Should be successfully initialized with account-2, and ensureReady should not throw
      await expect(manager.ensureReady()).resolves.toBeDefined()
    })

    it('allows ensureReady to wait for initialization during re-initialization with a new account', async () => {
      await manager.initialize('account-one')

      let resolveInitRepo: () => void = () => {}
      mockSyncApi.initRepo.mockImplementationOnce(
        () =>
          new Promise<void>(resolve => {
            resolveInitRepo = resolve
          }),
      )

      const initTwoPromise = manager.initialize('account-two')
      const ensureReadyPromise = manager.ensureReady()

      // ensureReady should be pending and not throw prematurely
      let ready = false
      void ensureReadyPromise.then(() => {
        ready = true
      })

      await flushPromises()
      expect(ready).toBe(false)

      resolveInitRepo()
      await initTwoPromise
      await ensureReadyPromise
      expect(ready).toBe(true)
    })

    it('safely handles concurrent initialize calls for different accounts without destroying the newer promise', async () => {
      let resolveKeyringA: (val: string) => void = () => {}
      let resolveKeyringB: (val: string) => void = () => {}

      vi.mocked(vaultModule.exportKeyringData)
        .mockImplementationOnce(() => new Promise<string>(resolve => { resolveKeyringA = resolve }))
        .mockImplementationOnce(() => new Promise<string>(resolve => { resolveKeyringB = resolve }))

      const initAPromise = manager.initialize('account-A')
      const initBPromise = manager.initialize('account-B')

      const ensureReadyPromise = manager.ensureReady()

      let ready = false
      void ensureReadyPromise.then(() => {
        ready = true
      })

      // Release A's keyring -> A discovers account changed to B and aborts
      resolveKeyringA('key-a')
      await initAPromise

      // ensureReady should still be pending on B
      await flushPromises()
      expect(ready).toBe(false)

      // Release B's keyring -> B finishes
      resolveKeyringB('key-b')
      await initBPromise
      await ensureReadyPromise
      expect(ready).toBe(true)
    })

    it('schedules retry with backoff on initialization failure and queues ensureReady callers', async () => {
      vi.useFakeTimers()
      mockSyncApi.initRepo.mockRejectedValueOnce(new Error('initRepo failed transiently'))

      const initPromise = manager.initialize('retry-account')
      await expect(initPromise).rejects.toThrow('initRepo failed transiently')

      // Warning is set
      expect(callbacks.onSyncWarning).toHaveBeenLastCalledWith('Sync initialization failed. Retrying in 2s...')

      // ensureReady callers wait on the retry
      let ready = false
      const ensureReadyPromise = manager.ensureReady().then(() => {
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
      expect(callbacks.onSyncWarning).toHaveBeenLastCalledWith(null)

      vi.useRealTimers()
    })
  })

  describe('worker crashes', () => {
    it('attempts to restart the worker and dispatches to window if worker error event is triggered', async () => {
      vi.useFakeTimers()
      const windowDispatchSpy = vi.spyOn(window, 'dispatchEvent')
      await manager.initialize('test-account')
      expect(workers).toHaveLength(1)

      // Trigger the error event
      workers[0].dispatchEvent(new ErrorEvent('error', { message: 'WASM crash' }))

      // Expect window error event dispatched
      expect(windowDispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'WASM crash' }),
      )

      // Expect status to be connecting, and reconnect warning set
      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('connecting')
      expect(callbacks.onSyncWarning).toHaveBeenLastCalledWith('Sync connection lost. Reconnecting...')

      // Fast-forward 1000ms for the restart timer
      await vi.advanceTimersByTimeAsync(1000)

      expect(callbacks.onRestart).toHaveBeenCalledTimes(1)
      expect(callbacks.onRestart).toHaveBeenCalledWith('test-account')
      windowDispatchSpy.mockRestore()
      vi.useRealTimers()
    })

    it('detects a hung worker via heartbeat and restarts it', async () => {
      vi.useFakeTimers()
      callbacks.createWorker = () => {
        const worker = new MockWorker('vault.worker.js', { type: 'module' })
        // The ping port is never answered
        worker.postMessage = vi.fn()
        workers.push(worker)
        return worker as unknown as Worker
      }

      await manager.initialize('test-account')

      // Move time forward by first timeout: HEARTBEAT_INTERVAL (15s) + HEARTBEAT_TIMEOUT (30s) = 45s
      await vi.advanceTimersByTimeAsync(45000)
      expect(callbacks.onSyncWarning).toHaveBeenLastCalledWith('Sync connection is slow. Checking...')

      // Move time forward by second timeout: HEARTBEAT_INTERVAL (15s) + HEARTBEAT_TIMEOUT (30s) = 45s -> total 90s
      await vi.advanceTimersByTimeAsync(45000)

      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('connecting')
      expect(callbacks.onSyncWarning).toHaveBeenLastCalledWith('Sync connection lost. Reconnecting...')

      // Fast-forward another 1000ms for the restart timer
      await vi.advanceTimersByTimeAsync(1000)
      expect(callbacks.onRestart).toHaveBeenCalledTimes(1)

      vi.useRealTimers()
    })

    it('halts auto-restart and sets a fatal error after 3 consecutive crashes', async () => {
      vi.useFakeTimers()
      callbacks.onRestart = vi.fn((accountId: string) => manager.initialize(accountId))
      await manager.initialize('test-account')

      // First crash
      workers.at(-1)!.dispatchEvent(new ErrorEvent('error', { message: 'crash 1' }))
      await vi.advanceTimersByTimeAsync(1000) // triggers restart
      expect(callbacks.onRestart).toHaveBeenCalledTimes(1)

      // Second crash
      workers.at(-1)!.dispatchEvent(new ErrorEvent('error', { message: 'crash 2' }))
      await vi.advanceTimersByTimeAsync(1000) // triggers restart
      expect(callbacks.onRestart).toHaveBeenCalledTimes(2)

      // Third crash
      workers.at(-1)!.dispatchEvent(new ErrorEvent('error', { message: 'crash 3' }))

      // No more restarts. Fatal error should be set.
      expect(callbacks.onFatalError).toHaveBeenCalledWith('Sync worker crashed repeatedly. Please refresh the page to try again.')
      expect(callbacks.onStatusChange).toHaveBeenLastCalledWith('dead')
      await vi.advanceTimersByTimeAsync(1000)
      expect(callbacks.onRestart).toHaveBeenCalledTimes(2) // should not have incremented

      vi.useRealTimers()
    })

    it('queues mutations during worker crash and applies them after restart', async () => {
      vi.useFakeTimers()
      callbacks.onRestart = vi.fn((accountId: string) => manager.initialize(accountId))
      await manager.initialize('test-account')
      expect(workers).toHaveLength(1)

      // Crash the worker
      workers[0].dispatchEvent(new ErrorEvent('error', { message: 'crash' }))

      // Issue mutation during restart gap
      let mutationResolved = false
      const mutatePromise = manager.ensureReady()
        .then(api => api.mutateItem('item-1' as ItemId, { name: 'queued' }))
        .then(() => {
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
  })

  describe('message ports', () => {
    const originalMessageChannel = globalThis.MessageChannel
    /** The `close` spy of each channel's `port1`, oldest first. Each session opens two channels. */
    let channelCloseSpies: ReturnType<typeof vi.fn>[]

    beforeEach(() => {
      channelCloseSpies = []
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
    })

    afterEach(() => {
      globalThis.MessageChannel = originalMessageChannel
    })

    it('closes the event and ping ports on worker crash', async () => {
      await manager.initialize('test-account')
      expect(workers).toHaveLength(1)
      expect(channelCloseSpies.length).toBe(2)
      channelCloseSpies.forEach(spy => expect(spy).not.toHaveBeenCalled())

      // Trigger worker crash error
      workers[0].dispatchEvent(new ErrorEvent('error', { message: 'crash' }))

      channelCloseSpies.forEach(spy => expect(spy).toHaveBeenCalledTimes(1))
    })

    it('closes the event and ping ports when initialization is aborted', async () => {
      let init1ResolveRepo: () => void = () => {}
      mockSyncApi.initRepo.mockImplementation((accountId: string) => {
        if (accountId === 'account-1') {
          return new Promise<void>(resolve => {
            init1ResolveRepo = resolve
          })
        }
        return Promise.resolve()
      })

      const init1Promise = manager.initialize('account-1')

      // Session 1 channels have been created (event and ping)
      await vi.waitFor(() => expect(channelCloseSpies.length).toBe(2))
      expect(channelCloseSpies[0]).not.toHaveBeenCalled()
      expect(channelCloseSpies[1]).not.toHaveBeenCalled()

      // Concurrently start session 2, which supersedes session 1
      const init2Promise = manager.initialize('account-2')
      await vi.waitFor(() => expect(channelCloseSpies.length).toBe(4))

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
    })

    it('does not close newer session ports when a superseded initialization fails', async () => {
      let init1RejectRepo: (err: Error) => void = () => {}
      mockSyncApi.initRepo.mockImplementation((accountId: string) => {
        if (accountId === 'account-fail') {
          return new Promise<void>((_, reject) => {
            init1RejectRepo = reject
          })
        }
        return Promise.resolve()
      })

      const init1Promise = manager.initialize('account-fail')

      // Session 1 has created 2 channels
      await vi.waitFor(() => expect(channelCloseSpies.length).toBe(2))

      // Session 2 starts and initializes successfully with account-success
      await manager.initialize('account-success')

      // Session 2 created 2 new channels (indices 2 and 3)
      expect(channelCloseSpies.length).toBe(4)
      expect(channelCloseSpies[2]).not.toHaveBeenCalled()
      expect(channelCloseSpies[3]).not.toHaveBeenCalled()

      // Session 2 superseded session 1 and shut its worker down, so session 1 gives up quietly,
      // even when its initRepo fails later
      await expect(init1Promise).resolves.toBeUndefined()
      init1RejectRepo(new Error('Init 1 failed'))

      // Session 1's own ports should be closed
      await vi.waitFor(() => {
        expect(channelCloseSpies[0]).toHaveBeenCalled()
        expect(channelCloseSpies[1]).toHaveBeenCalled()
      })

      // Session 2's ports must NOT have been closed by session 1
      expect(channelCloseSpies[2]).not.toHaveBeenCalled()
      expect(channelCloseSpies[3]).not.toHaveBeenCalled()

      // And ensureReady should succeed because session 2 is active
      await expect(manager.ensureReady()).resolves.toBeDefined()
    })
  })

  describe('clearing local data on shutdown', () => {
    it('clears local data when shutdown({ clearLocalData: true }) is called after the worker is already shut down', async () => {
      await manager.initialize('test-account-cleared')
      // Simulate unmount shutdown without args
      await manager.shutdown()

      // Now explicit logout occurs when syncApi is null
      await expect(manager.shutdown({ clearLocalData: true, accountId: 'test-account-cleared' })).resolves.not.toThrow()
      expect(clearAccountLocalDataSpy).toHaveBeenCalledWith('test-account-cleared')
    })

    it('preserves clearLocalData instruction when concurrent shutdown() is followed by shutdown({ clearLocalData: true })', async () => {
      await manager.initialize('test-account-race-1')

      let resolveShutdown: () => void = () => {}
      mockSyncApi.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveShutdown = resolve
      }))

      // Unmount starts shutdown without clearLocalData
      const unmountShutdown = manager.shutdown()

      // Logout thunk immediately calls shutdown with clearLocalData: true
      const logoutShutdown = manager.shutdown({ clearLocalData: true, accountId: 'test-account-race-1' })

      resolveShutdown()
      await unmountShutdown
      await logoutShutdown

      expect(clearAccountLocalDataSpy).toHaveBeenCalledWith('test-account-race-1')
      expect(manager.isClearingLocalData()).toBe(false)
    })

    it('preserves clearLocalData instruction when shutdown({ clearLocalData: true }) is followed by unmount shutdown()', async () => {
      await manager.initialize('test-account-race-2')

      let resolveShutdown: () => void = () => {}
      mockSyncApi.shutdown.mockImplementationOnce(() => new Promise<void>(resolve => {
        resolveShutdown = resolve
      }))

      // Logout thunk starts shutdown with clearLocalData: true
      const logoutShutdown = manager.shutdown({ clearLocalData: true, accountId: 'test-account-race-2' })

      // Unmount effect fires shutdown without args while logout is in-flight
      const unmountShutdown = manager.shutdown()

      resolveShutdown()
      await logoutShutdown
      await unmountShutdown

      expect(mockSyncApi.shutdown).toHaveBeenCalledWith(
        expect.objectContaining({ clearLocalData: true }),
      )
    })

    it('executes clearLocalData if requestClearOnShutdown was called before unmount shutdown', async () => {
      await manager.initialize('test-account-preempt')

      manager.requestClearOnShutdown('test-account-preempt')
      expect(manager.isClearingLocalData()).toBe(true)

      await manager.shutdown()

      expect(mockSyncApi.shutdown).toHaveBeenCalledWith(
        expect.objectContaining({ clearLocalData: true }),
      )
      expect(manager.isClearingLocalData()).toBe(false)
    })
  })
})
