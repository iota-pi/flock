import * as Comlink from 'comlink'

import type { SyncApi } from '../worker/syncProtocol'
import type { ClientEvent } from '../worker/SyncEventHub'
import type { SyncStatus } from '../shared/types'
import { exportKeyringData } from '../../api/vault'
import { getVaultSession } from '../../api/session'
import { hasRandomDataKeys } from '../../api/storedMetadata'
import {
  SyncWorkerHealthMonitor,
} from './syncWorkerHealth'
import { getOnlineState } from '../utils/onlineStatus'
import { clearAccountLocalData } from './localDataCleanup'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'
import { AbortError } from '../utils/abort'
import { noopTelemetry, type SyncTelemetry } from './host'

const log = createLogger('WorkerLifecycleManager')

/**
 * Settles with `promise`, or rejects with an AbortError once `signal` aborts. A call to a worker
 * that has been terminated never settles, so initialization would otherwise wait forever.
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new AbortError('Initialization aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortError('Initialization aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export interface WorkerLifecycleCallbacks {
  /** Creates the app's sync worker (whose entry file calls exposeSyncWorker) */
  createWorker: () => Worker
  telemetry?: SyncTelemetry
  onEvent: (event: ClientEvent) => void
  onReady?: () => void
  onRestart: (accountId: string) => Promise<void>
  onShutdownCleanup?: (options?: { internalRestart?: boolean }) => void
  onStatusChange: (status: SyncStatus) => void
  onSyncWarning?: (message: string | null) => void
  onFatalError?: (message: string) => void
  getAccountId?: () => string | null
}

export interface WorkerInitOptions {
  clearLocalData?: boolean
}

export class WorkerLifecycleManager {
  private syncApi: Comlink.Remote<SyncApi> | null = null
  /** The worker's API while it initializes, so a shutdown in the meantime can still shut it down */
  private initializingApi: Comlink.Remote<SyncApi> | null = null
  private workerInstance: Worker | null = null
  private currentAccountId: string | null = null
  private lastKnownAccountId: string | null = null
  private readonly pendingShutdownClearAccounts = new Set<string>()
  private activeShutdownPromise: Promise<void> | null = null

  private globalEventChannel: MessageChannel | null = null
  private pingChannel: MessageChannel | null = null

  private initializationPromise: Promise<void> | null = null
  private initAbortController: AbortController | null = null
  private static readonly MAX_INIT_RETRIES = 5
  private readonly initRetryStrategy = new RetryStrategy({
    delays: DEFAULT_RETRY_DELAYS,
    maxAttempts: WorkerLifecycleManager.MAX_INIT_RETRIES,
  })

  private get initRetryCount(): number {
    return this.initRetryStrategy.attempt
  }

  private set initRetryCount(val: number) {
    this.initRetryStrategy.attempt = val
  }

  /** Settles the pending `initializationPromise` that mutations wait on while a crashed worker restarts */
  private pendingRestart: PromiseWithResolvers<void> | null = null

  private resolvePendingRestart(): void {
    this.pendingRestart?.resolve()
    this.pendingRestart = null
  }

  private readonly healthMonitor = new SyncWorkerHealthMonitor({
    setSyncStatus: status => this.callbacks.onStatusChange(status),
    setSyncWarning: message => this.callbacks.onSyncWarning?.(message),
    setFatalError: message => this.callbacks.onFatalError?.(message),
  })

  constructor(private callbacks: WorkerLifecycleCallbacks) {}

  private get telemetry(): SyncTelemetry {
    return this.callbacks.telemetry ?? noopTelemetry
  }

  recordWorkerActivity(): void {
    this.healthMonitor.recordActivity()
  }

  getSyncApi(): Comlink.Remote<SyncApi> | null {
    return this.syncApi
  }

  getCurrentAccountId(): string | null {
    return this.currentAccountId
  }

  requestClearOnShutdown(accountId?: string): void {
    const target = accountId || this.currentAccountId || this.lastKnownAccountId || this.callbacks.getAccountId?.()
    if (target) {
      this.pendingShutdownClearAccounts.add(target)
      this.lastKnownAccountId = target
    }
  }

  isClearingLocalData(accountId?: string): boolean {
    if (accountId) {
      return this.pendingShutdownClearAccounts.has(accountId)
    }
    return this.pendingShutdownClearAccounts.size > 0
  }

  async ensureReady(): Promise<Comlink.Remote<SyncApi>> {
    if (this.initializationPromise) {
      await this.initializationPromise
    }
    if (!this.syncApi) {
      throw new Error('SyncBridge not initialized')
    }
    return this.syncApi
  }

  initialize(accountId: string, options?: WorkerInitOptions): Promise<void> {
    if (this.syncApi && this.currentAccountId === accountId && !options?.clearLocalData) {
      return Promise.resolve()
    }
    if (this.initializationPromise && this.currentAccountId === accountId && !options?.clearLocalData) {
      return this.initializationPromise
    }

    this.lastKnownAccountId = accountId
    this.currentAccountId = accountId

    this.initAbortController?.abort()
    const abortController = new AbortController()
    this.initAbortController = abortController
    const { signal } = abortController

    this.initializationPromise = (async () => {
      if (this.activeShutdownPromise) {
        await this.activeShutdownPromise
      }
      if (signal.aborted || this.currentAccountId !== accountId) {
        return
      }

      if (this.syncApi || this.workerInstance) {
        await this.shutdown({ internalRestart: true, clearLocalData: options?.clearLocalData, accountId })
      } else if (options?.clearLocalData) {
        await clearAccountLocalData(accountId)
      }

      if (signal.aborted || this.currentAccountId !== accountId) {
        return
      }

      this.callbacks.onStatusChange?.('connecting')
      const initialOnlineState = getOnlineState()

      let worker: Worker | null = null
      let wrappedApi: Comlink.Remote<SyncApi> | null = null
      let globalEventChannel: MessageChannel | null = null
      let pingChannel: MessageChannel | null = null
      let didAssignSyncApi = false

      const cleanupSessionResources = () => {
        if (worker) {
          worker.terminate()
        }
        if (globalEventChannel) {
          globalEventChannel.port1.onmessage = null
          globalEventChannel.port1.close()
        }
        if (pingChannel) {
          pingChannel.port1.close()
        }
        if (this.workerInstance === worker) {
          this.workerInstance = null
        }
        if (this.globalEventChannel === globalEventChannel) {
          this.globalEventChannel = null
        }
        if (this.pingChannel === pingChannel) {
          this.pingChannel = null
        }
        if (didAssignSyncApi && this.syncApi === wrappedApi) {
          this.syncApi = null
        }
        if (this.initializingApi === wrappedApi) {
          this.initializingApi = null
        }
      }
      // Whatever aborted this run (a shutdown, or a newer initialize, which shuts the old worker down)
      // takes over the worker and shuts it down cleanly, so an aborted run leaves it alone
      const isAborted = () => signal.aborted || this.currentAccountId !== accountId

      try {
        const vaultKey = await exportKeyringData()
        if (!vaultKey) throw new Error('Vault key not found in storage')

        if (isAborted()) {
          log.warn('Initialization aborted due to account change or concurrent shutdown')
          return
        }

        worker = this.callbacks.createWorker()
        worker.addEventListener('error', (event: ErrorEvent) => {
          const error = event.error || new Error(event.message || 'Sync Worker Error')
          log.error('Worker error:', error)
          this.telemetry.captureException(error, { origin: 'sync-worker-host' })
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new ErrorEvent('error', { error, message: event.message || error.message }))
          }
        })

        this.workerInstance = worker
        wrappedApi = Comlink.wrap<SyncApi>(worker)
        this.initializingApi = wrappedApi

        globalEventChannel = new MessageChannel()
        this.globalEventChannel = globalEventChannel
        globalEventChannel.port1.onmessage = ev => {
          this.callbacks.onEvent(ev.data as ClientEvent)
        }
        globalEventChannel.port1.start()
        worker.postMessage({ type: 'EVENT_PORT', port: globalEventChannel.port2 }, [globalEventChannel.port2])

        pingChannel = new MessageChannel()
        this.pingChannel = pingChannel
        pingChannel.port1.start()
        worker.postMessage({ type: 'INIT_PING_PORT', port: pingChannel.port2 }, [pingChannel.port2])

        await untilAborted(
          wrappedApi.initRepo(accountId, vaultKey, {
            randomDataKeys: hasRandomDataKeys(accountId),
            authToken: getVaultSession() || null,
          }),
          signal,
        )
        const currentSession = getVaultSession()
        if (currentSession) {
          await untilAborted(wrappedApi.updateAuthToken(currentSession), signal)
        }
        if (isAborted()) {
          log.warn('Initialization aborted due to account change or concurrent shutdown')
          return
        }

        await untilAborted(wrappedApi.setOnlineState(initialOnlineState), signal)
        if (isAborted()) {
          log.warn('Initialization aborted due to account change or concurrent shutdown')
          return
        }

        await untilAborted(wrappedApi.bootstrapItems(), signal)
        this.healthMonitor.recordActivity()

        if (isAborted()) {
          log.warn('Initialization aborted due to account change or concurrent shutdown')
          return
        }

        this.syncApi = wrappedApi
        this.initializingApi = null
        didAssignSyncApi = true

        this.callbacks.onReady?.()

        this.initRetryCount = 0
        this.callbacks.onSyncWarning?.(null)
        this.healthMonitor.setupWorkerHealthCheck({
          worker,
          pingPort: pingChannel.port1,
          isCurrentWorker: () => this.workerInstance === worker && !!this.syncApi,
          onCrash: (willRestart = true) => {
            if (this.workerInstance === worker) {
              if (globalEventChannel) {
                globalEventChannel.port1.onmessage = null
                globalEventChannel.port1.close()
              }
              if (this.globalEventChannel === globalEventChannel) {
                this.globalEventChannel = null
              }
              if (pingChannel) {
                pingChannel.port1.close()
              }
              if (this.pingChannel === pingChannel) {
                this.pingChannel = null
              }
              this.workerInstance = null
              this.syncApi = null
              if (willRestart) {
                // Keep initializationPromise as a pending promise so mutations queue up
                this.pendingRestart = Promise.withResolvers<void>()
                this.initializationPromise = this.pendingRestart.promise
              } else {
                this.initializationPromise = null
                this.resolvePendingRestart()
              }
            }
          },
          onRestart: () => {
            setTimeout(() => {
              if (this.currentAccountId === accountId) {
                this.initializationPromise = null
                this.callbacks.onRestart(accountId)
                  .then(() => this.resolvePendingRestart())
                  .catch(err => {
                    log.error('Auto-restart initialization failed:', err)
                    this.resolvePendingRestart()
                  })
              } else {
                this.resolvePendingRestart()
              }
            }, SYNC_TIMEOUTS.workerRestartDelay)
          },
        })
      } catch (error) {
        if (isAborted()) {
          log.warn('Initialization aborted due to account change or concurrent shutdown')
          return
        }
        log.error('Failed to initialize SyncBridge:', error)
        cleanupSessionResources()

        if (!signal.aborted && this.initRetryStrategy.canRetry) {
          const delay = this.initRetryStrategy.nextDelay()
          this.callbacks.onSyncWarning?.(`Sync initialization failed. Retrying in ${delay / 1000}s...`)

          // Keep initializationPromise alive so ensureReady() callers wait
          const retryPromise = new Promise<void>((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | null = null
            const onAbort = () => {
              if (timer !== null) {
                clearTimeout(timer)
                timer = null
              }
              reject(new Error('Aborted'))
            }

            timer = setTimeout(() => {
              timer = null
              signal.removeEventListener('abort', onAbort)
              if (signal.aborted) return reject(new Error('Aborted'))
              this.initializationPromise = null
              this.initialize(accountId, options).then(resolve).catch(reject)
            }, delay)

            signal.addEventListener('abort', onAbort, { once: true })
          })
          retryPromise.catch(() => {})
          this.initializationPromise = retryPromise
        } else {
          // Exhausted retries — surface to user
          if (!signal.aborted) {
            this.callbacks.onFatalError?.('Unable to start sync. Please refresh the page.')
            this.callbacks.onStatusChange?.('offline')
            this.currentAccountId = null
            this.initializationPromise = null
          }
        }
        throw error
      }
    })()

    return this.initializationPromise
  }

  async shutdown(options?: { clearLocalData?: boolean; internalRestart?: boolean; accountId?: string }) {
    const targetAccountId =
      options?.accountId ||
      this.currentAccountId ||
      this.lastKnownAccountId ||
      this.callbacks.getAccountId?.() ||
      null

    if (options?.clearLocalData && targetAccountId) {
      this.pendingShutdownClearAccounts.add(targetAccountId)
    }
    if (options?.accountId) {
      this.lastKnownAccountId = options.accountId
    } else if (this.currentAccountId) {
      this.lastKnownAccountId = this.currentAccountId
    }

    if (this.activeShutdownPromise) {
      await this.activeShutdownPromise
      if (targetAccountId && (options?.clearLocalData || this.pendingShutdownClearAccounts.has(targetAccountId))) {
        await clearAccountLocalData(targetAccountId)
        this.pendingShutdownClearAccounts.delete(targetAccountId)
      }
      return
    }

    const shutdownPromise = this._performShutdown(options)
    this.activeShutdownPromise = shutdownPromise
    try {
      await shutdownPromise
    } finally {
      if (this.activeShutdownPromise === shutdownPromise) {
        this.activeShutdownPromise = null
      }
    }
  }

  private async _performShutdown(options?: { clearLocalData?: boolean; internalRestart?: boolean; accountId?: string }) {
    const targetAccountId =
      options?.accountId ||
      this.currentAccountId ||
      this.lastKnownAccountId ||
      this.callbacks.getAccountId?.() ||
      null

    const shouldClearLocalData = Boolean(
      options?.clearLocalData || (targetAccountId && this.pendingShutdownClearAccounts.has(targetAccountId))
    )

    if (!options?.internalRestart) {
      this.initAbortController?.abort()
      this.initAbortController = null
      this.initializationPromise = null
      this.currentAccountId = null
    }
    this.initRetryCount = 0
    this.resolvePendingRestart()
    this.healthMonitor.stopWorkerHeartbeat()
    this.healthMonitor.resetCrashMetrics()

    const oldWorker = this.workerInstance
    const oldSyncApi = this.syncApi ?? this.initializingApi
    this.initializingApi = null
    const oldGlobalEventChannel = this.globalEventChannel
    const oldPingChannel = this.pingChannel
    this.workerInstance = null
    this.syncApi = null
    this.globalEventChannel = null
    this.pingChannel = null

    this.callbacks.onShutdownCleanup?.(options)

    if (oldSyncApi) {
      try {
        await Promise.race([
          oldSyncApi.shutdown({
            ...options,
            clearLocalData: shouldClearLocalData,
          }),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('Sync worker shutdown timed out')), SYNC_TIMEOUTS.workerShutdown)
          ),
        ])
      } catch (err) {
        log.error('Failed to shut down worker cleanly:', err)
      }
    }

    if (oldWorker) {
      oldWorker.terminate()
    }
    if (oldGlobalEventChannel) {
      oldGlobalEventChannel.port1.close()
    }
    if (oldPingChannel) {
      oldPingChannel.port1.close()
    }
    if (!this.initializationPromise) {
      this.callbacks.onStatusChange?.('offline')
    }

    if (shouldClearLocalData && targetAccountId) {
      await clearAccountLocalData(targetAccountId)
      this.pendingShutdownClearAccounts.delete(targetAccountId)
    }
  }
}
