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
import { AbortError, untilAborted } from '../utils/abort'
import { noopTelemetry, type SyncTelemetry } from './host'

const log = createLogger('WorkerLifecycleManager')

/** A running sync worker with its Comlink API and the event and ping channels to it */
class WorkerSession {
  readonly api: Comlink.Remote<SyncApi>
  private readonly eventChannel = new MessageChannel()
  private readonly pingChannel = new MessageChannel()

  constructor(readonly worker: Worker, onEvent: (event: ClientEvent) => void) {
    this.api = Comlink.wrap<SyncApi>(worker)
    try {
      this.eventChannel.port1.onmessage = ev => {
        onEvent(ev.data as ClientEvent)
      }
      this.eventChannel.port1.start()
      worker.postMessage({ type: 'EVENT_PORT', port: this.eventChannel.port2 }, [this.eventChannel.port2])

      this.pingChannel.port1.start()
      worker.postMessage({ type: 'INIT_PING_PORT', port: this.pingChannel.port2 }, [this.pingChannel.port2])
    } catch (error) {
      this.close()
      throw error
    }
  }

  get pingPort(): MessagePort {
    return this.pingChannel.port1
  }

  close(): void {
    this.worker.terminate()
    this.eventChannel.port1.onmessage = null
    this.eventChannel.port1.close()
    this.pingChannel.port1.close()
  }
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
  /** The current worker, set as soon as it starts so a shutdown during initialization can shut it down */
  private session: WorkerSession | null = null
  /** The current session's API, once it has initialized */
  private syncApi: Comlink.Remote<SyncApi> | null = null
  private currentAccountId: string | null = null
  private lastKnownAccountId: string | null = null
  private readonly pendingShutdownClearAccounts = new Set<string>()
  private activeShutdownPromise: Promise<void> | null = null

  private initializationPromise: Promise<void> | null = null
  private initAbortController: AbortController | null = null
  private static readonly MAX_INIT_RETRIES = 5
  private readonly initRetryStrategy = new RetryStrategy({
    delays: DEFAULT_RETRY_DELAYS,
    maxAttempts: WorkerLifecycleManager.MAX_INIT_RETRIES,
  })

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

  /** The account a shutdown or local data clear applies to when none is given */
  private resolveTargetAccountId(accountId?: string): string | null {
    return accountId || this.currentAccountId || this.lastKnownAccountId || this.callbacks.getAccountId?.() || null
  }

  requestClearOnShutdown(accountId?: string): void {
    const target = this.resolveTargetAccountId(accountId)
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

    this.initAbortController?.abort(new AbortError('Initialization aborted'))
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

      if (this.session) {
        await this.shutdown({ internalRestart: true, clearLocalData: options?.clearLocalData, accountId })
      } else if (options?.clearLocalData) {
        await clearAccountLocalData(accountId)
      }

      if (signal.aborted || this.currentAccountId !== accountId) {
        return
      }

      this.callbacks.onStatusChange('connecting')
      const initialOnlineState = getOnlineState()

      let session: WorkerSession | null = null

      // Whatever aborted this run (a shutdown, or a newer initialize, which shuts the old worker down)
      // takes over the worker and shuts it down cleanly, so an aborted run leaves it alone
      const isAborted = () => signal.aborted || this.currentAccountId !== accountId
      const throwIfAborted = () => {
        if (isAborted()) throw new AbortError('Initialization aborted')
      }

      try {
        const vaultKey = await exportKeyringData()
        if (!vaultKey) throw new Error('Vault key not found in storage')
        throwIfAborted()

        const worker = this.callbacks.createWorker()
        worker.addEventListener('error', (event: ErrorEvent) => {
          const error = event.error || new Error(event.message || 'Sync Worker Error')
          log.error('Worker error:', error)
          this.telemetry.captureException(error, { origin: 'sync-worker-host' })
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new ErrorEvent('error', { error, message: event.message || error.message }))
          }
        })

        const currentSession = new WorkerSession(worker, event => this.callbacks.onEvent(event))
        session = currentSession
        this.session = currentSession
        const api = currentSession.api

        await untilAborted(
          api.initRepo(accountId, vaultKey, {
            randomDataKeys: hasRandomDataKeys(accountId),
            authToken: getVaultSession() || null,
          }),
          signal,
        )
        const authToken = getVaultSession()
        if (authToken) {
          await untilAborted(api.updateAuthToken(authToken), signal)
        }
        throwIfAborted()

        await untilAborted(api.setOnlineState(initialOnlineState), signal)
        throwIfAborted()

        await untilAborted(api.bootstrapItems(), signal)
        this.healthMonitor.recordActivity()
        throwIfAborted()

        this.syncApi = api

        this.callbacks.onReady?.()

        this.initRetryStrategy.reset()
        this.callbacks.onSyncWarning?.(null)
        this.healthMonitor.setupWorkerHealthCheck({
          worker,
          pingPort: currentSession.pingPort,
          isCurrentWorker: () => this.session === currentSession && !!this.syncApi,
          onCrash: (willRestart = true) => {
            if (this.session === currentSession) {
              currentSession.close()
              this.session = null
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
        if (session) {
          session.close()
          if (this.session === session) {
            this.session = null
          }
          if (this.syncApi === session.api) {
            this.syncApi = null
          }
        }

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
            this.callbacks.onStatusChange('offline')
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
    const targetAccountId = this.resolveTargetAccountId(options?.accountId)

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
    const targetAccountId = this.resolveTargetAccountId(options?.accountId)

    const shouldClearLocalData = Boolean(
      options?.clearLocalData || (targetAccountId && this.pendingShutdownClearAccounts.has(targetAccountId))
    )

    if (!options?.internalRestart) {
      this.initAbortController?.abort(new AbortError('Initialization aborted'))
      this.initAbortController = null
      this.initializationPromise = null
      this.currentAccountId = null
    }
    this.initRetryStrategy.reset()
    this.resolvePendingRestart()
    this.healthMonitor.stopWorkerHeartbeat()
    this.healthMonitor.resetCrashMetrics()

    const oldSession = this.session
    this.session = null
    this.syncApi = null

    this.callbacks.onShutdownCleanup?.(options)

    if (oldSession) {
      try {
        await Promise.race([
          oldSession.api.shutdown({
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
      oldSession.close()
    }

    if (!this.initializationPromise) {
      this.callbacks.onStatusChange('offline')
    }

    if (shouldClearLocalData && targetAccountId) {
      await clearAccountLocalData(targetAccountId)
      this.pendingShutdownClearAccounts.delete(targetAccountId)
    }
  }
}
