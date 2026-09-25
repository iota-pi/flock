import * as Comlink from 'comlink'

import type { SyncApi } from 'src/sync/worker/syncProtocol'
import type { ClientEvent } from '../worker/SyncEventHub'
import type { SyncStatus } from 'src/state/slices/syncSlice'
import { exportKeyringData, handleSessionExpired, getVaultSession } from 'src/api/vault'
import {
  SyncWorkerHealthMonitor,
} from './syncWorkerHealth'
import { getOnlineState } from 'src/utils/onlineStatus'
import { clearAccountLocalData } from './localDataCleanup'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { SYNC_TIMEOUTS } from '../syncConfig'

export interface WorkerLifecycleCallbacks {
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
  private static readonly INIT_RETRY_DELAYS = DEFAULT_RETRY_DELAYS
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

  private _restartResolve: (() => void) | null = null

  private readonly healthMonitor = new SyncWorkerHealthMonitor()

  constructor(private callbacks: WorkerLifecycleCallbacks) {}

  getHealthMonitor(): SyncWorkerHealthMonitor {
    return this.healthMonitor
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

  getWorkerInstance(): Worker | null {
    return this.workerInstance
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

  hasPendingClear(accountId?: string): boolean {
    return this.isClearingLocalData(accountId)
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

  init(accountId: string, options?: WorkerInitOptions): Promise<void> {
    return this.initialize(accountId, options)
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
      }

      try {
        const vaultKey = await exportKeyringData()
        if (!vaultKey) throw new Error('Vault key not found in storage')

        if (signal.aborted || this.currentAccountId !== accountId) {
          console.warn('[WorkerLifecycleManager] Initialization aborted due to account change or concurrent shutdown')
          cleanupSessionResources()
          return
        }

        worker = new Worker(new URL('../worker/sync.worker.ts', import.meta.url), { type: 'module' })
        worker.addEventListener('error', (event: ErrorEvent) => {
          const error = event.error || new Error(event.message || 'Sync Worker Error')
          console.error('[WorkerLifecycleManager] Worker error:', error)
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new ErrorEvent('error', { error, message: event.message || error.message }))
          }
        })

        this.workerInstance = worker
        wrappedApi = Comlink.wrap<SyncApi>(worker)

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

        const refreshAuthToken = Comlink.proxy(async () => {
          await handleSessionExpired()
          return getVaultSession() || null
        })

        await wrappedApi.initRepo(accountId, vaultKey, refreshAuthToken)
        if (signal.aborted || this.currentAccountId !== accountId) {
          console.warn('[WorkerLifecycleManager] Initialization aborted due to account change or concurrent shutdown')
          cleanupSessionResources()
          return
        }

        await wrappedApi.setOnlineState(initialOnlineState)
        if (signal.aborted || this.currentAccountId !== accountId) {
          console.warn('[WorkerLifecycleManager] Initialization aborted due to account change or concurrent shutdown')
          cleanupSessionResources()
          return
        }

        await wrappedApi.bootstrapItems()
        this.healthMonitor.recordActivity()

        if (signal.aborted || this.currentAccountId !== accountId) {
          console.warn('[WorkerLifecycleManager] Initialization aborted due to account change or concurrent shutdown')
          cleanupSessionResources()
          return
        }

        this.syncApi = wrappedApi
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
                this.initializationPromise = new Promise(resolve => {
                  this._restartResolve = resolve
                })
              } else {
                this.initializationPromise = null
                this._restartResolve?.()
                this._restartResolve = null
              }
            }
          },
          onRestart: () => {
            setTimeout(() => {
              if (this.currentAccountId === accountId) {
                this.initializationPromise = null
                this.callbacks.onRestart(accountId)
                  .then(() => {
                    this._restartResolve?.()
                    this._restartResolve = null
                  })
                  .catch(err => {
                    console.error('[WorkerLifecycleManager] Auto-restart initialization failed:', err)
                    this._restartResolve?.()
                    this._restartResolve = null
                  })
              } else {
                this._restartResolve?.()
                this._restartResolve = null
              }
            }, SYNC_TIMEOUTS.workerRestartDelay)
          },
        })
      } catch (error) {
        console.error('Failed to initialize SyncBridge:', error)
        cleanupSessionResources()

        if (!signal.aborted && this.initRetryStrategy.canRetry) {
          const delay = this.initRetryStrategy.nextDelay()
          this.callbacks.onSyncWarning?.(`Sync initialization failed. Retrying in ${delay / 1000}s...`)

          // Keep initializationPromise alive so ensureReady() callers wait
          const retryPromise = new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              if (timer !== null) {
                clearTimeout(timer)
                timer = null
              }
              reject(new Error('Aborted'))
            }

            let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
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
    if (this._restartResolve) {
      this._restartResolve()
      this._restartResolve = null
    }
    this.healthMonitor.stopWorkerHeartbeat()
    this.healthMonitor.resetCrashMetrics()

    const oldWorker = this.workerInstance
    const oldSyncApi = this.syncApi
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
        console.error('[WorkerLifecycleManager] Failed to shut down worker cleanly:', err)
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
