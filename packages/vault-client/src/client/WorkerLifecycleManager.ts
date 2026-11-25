import * as Comlink from 'comlink'

import type { SyncApi } from '../worker/syncProtocol'
import type { ClientEvent } from '../worker/SyncEventHub'
import type { SyncStatus } from '../shared/types'
import { exportKeyringData } from '../keys/vault'
import { getVaultSession } from '../keys/session'
import {
  SyncWorkerHealthMonitor,
} from './SyncWorkerHealthMonitor'
import { getOnlineState } from '../utils/onlineStatus'
import { clearAccountLocalData } from './localDataCleanup'
import { RetryTimer } from '../utils/RetryTimer'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'
import { AbortError, untilAborted, withTimeout } from '../utils/abort'
import { noopTelemetry, type SyncTelemetry } from './host'
import {
  INITIAL_LIFECYCLE_STATE,
  isCurrentRun,
  isPending,
  phaseAccountId,
  transitionLifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecycleState,
} from './workerLifecycleState'

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

export interface WorkerShutdownOptions {
  clearLocalData?: boolean
  accountId?: string
}

export interface WorkerLifecycleCallbacks {
  /** Creates the app's sync worker (whose entry file calls exposeSyncWorker) */
  createWorker: () => Worker
  telemetry?: SyncTelemetry
  onEvent: (event: ClientEvent) => void
  onReady?: () => void
  /** The worker is closing. `internalRestart` means a new one is starting in its place, for the same account or another. */
  onShutdownCleanup?: (options: { internalRestart: boolean }) => void
  onStatusChange: (status: SyncStatus) => void
  onSyncWarning?: (message: string | null) => void
  onFatalError?: (message: string) => void
  getAccountId?: () => string | null
}

export interface WorkerInitOptions {
  clearLocalData?: boolean
}

/** A run starting a worker, which an `abortRun` effect aborts */
interface InitRun {
  id: number
  promise: Promise<void>
  abortController: AbortController
}

interface CloseOptions {
  accountId: string | null
  clearLocalData: boolean
  /** A new worker is starting in place of this one */
  internalRestart: boolean
  /** Runs once the worker has closed, before any local data is cleared */
  onClosed?: () => void
}

/**
 * Starts, restarts and shuts down the sync worker. Which of those it's doing is `state`, moved by
 * `transitionLifecycle` (workerLifecycleState.ts); this class holds the worker and carries out the
 * effects.
 */
export class WorkerLifecycleManager {
  private state: LifecycleState = INITIAL_LIFECYCLE_STATE
  /** The current worker, set as soon as it starts so whatever supersedes its run can shut it down */
  private session: WorkerSession | null = null
  private run: InitRun | null = null
  /** Retries a failed start, or restarts a crashed worker */
  private readonly timer = new RetryTimer()
  /** Settles once a worker is no longer on its way, for `ensureReady`. Set exactly while the phase is pending. */
  private settled: PromiseWithResolvers<void> | null = null
  /** Closing the worker. A run, or another shutdown, waits for it so local data is never cleared under a live worker. */
  private activeShutdown: Promise<void> | null = null
  private lastKnownAccountId: string | null = null
  private readonly pendingShutdownClearAccounts = new Set<string>()

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
    return this.state.phase.kind === 'ready' ? this.session?.api ?? null : null
  }

  getCurrentAccountId(): string | null {
    return phaseAccountId(this.state.phase)
  }

  /** The account a shutdown or local data clear applies to when none is given */
  private resolveTargetAccountId(accountId?: string): string | null {
    return accountId || this.getCurrentAccountId() || this.lastKnownAccountId || this.callbacks.getAccountId?.() || null
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

  /** The worker's API, waiting while one is starting, retrying or restarting */
  async ensureReady(): Promise<Comlink.Remote<SyncApi>> {
    while (this.settled) {
      await this.settled.promise
    }
    const api = this.getSyncApi()
    if (!api) {
      throw new Error('SyncBridge not initialized')
    }
    return api
  }

  /**
   * Starts a worker for the account. A start that fails rejects, and is retried in the background.
   * Joins a worker for the account that is already running or on its way, unless `clearLocalData`.
   */
  initialize(accountId: string, options?: WorkerInitOptions): Promise<void> {
    this.lastKnownAccountId = accountId
    this.dispatch({ type: 'initialize', accountId, clearLocalData: Boolean(options?.clearLocalData) })
    const { phase } = this.state
    if (phase.kind === 'starting' && this.run?.id === phase.run) {
      return this.run.promise
    }
    return this.settled?.promise ?? Promise.resolve()
  }

  async shutdown(options?: WorkerShutdownOptions): Promise<void> {
    const accountId = this.resolveTargetAccountId(options?.accountId)
    const clearLocalData = Boolean(options?.clearLocalData)
    if (clearLocalData && accountId) {
      this.pendingShutdownClearAccounts.add(accountId)
    }
    this.lastKnownAccountId = options?.accountId || this.getCurrentAccountId() || this.lastKnownAccountId

    this.dispatch({ type: 'shutdown' })
    await this.closeWorker({
      accountId,
      clearLocalData,
      internalRestart: false,
      onClosed: () => this.dispatch({ type: 'shutdownFinished' }),
    })
  }

  private dispatch(event: LifecycleEvent): void {
    const wasPending = isPending(this.state.phase)
    const { state, effects } = transitionLifecycle(this.state, event)
    this.state = state
    const pending = isPending(state.phase)
    if (!wasPending && pending) {
      this.settled = Promise.withResolvers<void>()
    } else if (wasPending && !pending) {
      this.settled?.resolve()
      this.settled = null
    }
    for (const effect of effects) {
      this.runEffect(effect)
    }
  }

  private runEffect(effect: LifecycleEffect): void {
    switch (effect.type) {
      case 'startRun':
        this.startRun(effect.run, effect.accountId, effect.clearLocalData)
        break
      case 'abortRun':
        this.run?.abortController.abort(new AbortError('Initialization aborted'))
        this.run = null
        break
      case 'armTimer':
        this.timer.schedule(effect.delayMs, () => this.dispatch({ type: 'timerFired' }))
        break
      case 'cancelTimer':
        this.timer.cancel()
        break
      case 'ready':
        this.onRunReady()
        break
      case 'reportRetry':
        this.callbacks.onSyncWarning?.(`Sync initialization failed. Retrying in ${effect.delayMs / 1000}s...`)
        break
      case 'reportFatal':
        this.callbacks.onFatalError?.('Unable to start sync. Please refresh the page.')
        this.callbacks.onStatusChange('offline')
        break
      case 'reportOffline':
        this.callbacks.onStatusChange('offline')
        break
    }
  }

  private startRun(id: number, accountId: string, clearLocalData: boolean): void {
    const run: InitRun = { id, promise: Promise.resolve(), abortController: new AbortController() }
    this.run = run
    run.promise = this.runInitialization(id, accountId, clearLocalData, run.abortController.signal)
    // A retry or restart has no caller to see its failure, which was logged
    run.promise.catch(() => {})
  }

  /**
   * Starts a worker for run `id`. Once a newer run or a shutdown supersedes it, it returns quietly:
   * whatever superseded it takes over the worker and shuts it down cleanly.
   */
  private async runInitialization(
    id: number,
    accountId: string,
    clearLocalData: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const isCurrent = () => isCurrentRun(this.state, id)
    if (this.activeShutdown) {
      await this.activeShutdown
    }
    if (!isCurrent()) {
      return
    }

    let session: WorkerSession | null = null
    try {
      if (this.session) {
        await this.closeWorker({ accountId, clearLocalData, internalRestart: true })
      } else if (clearLocalData) {
        await clearAccountLocalData(accountId)
      }
      if (!isCurrent()) {
        return
      }

      this.callbacks.onStatusChange('connecting')
      const onlineState = getOnlineState()
      const vaultKey = await exportKeyringData()
      throwIfSuperseded(isCurrent)

      session = this.startSession()
      await this.initSession(session, { accountId, vaultKey, onlineState, signal, isCurrent })
      this.dispatch({ type: 'runSucceeded', run: id })
    } catch (error) {
      if (!isCurrent()) {
        log.warn('Initialization aborted due to account change or concurrent shutdown')
        return
      }
      log.error('Failed to initialize SyncBridge:', error)
      if (session) {
        session.close()
        if (this.session === session) {
          this.session = null
        }
      }
      this.dispatch({ type: 'runFailed', run: id })
      throw error
    }
  }

  /** Starts a worker and makes it the current session, so a shutdown during initialization can shut it down */
  private startSession(): WorkerSession {
    const worker = this.callbacks.createWorker()
    worker.addEventListener('error', (event: ErrorEvent) => {
      const error = event.error || new Error(event.message || 'Sync Worker Error')
      log.error('Worker error:', error)
      this.telemetry.captureException(error, { origin: 'sync-worker-host' })
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new ErrorEvent('error', { error, message: event.message || error.message }))
      }
    })

    const session = new WorkerSession(worker, event => this.callbacks.onEvent(event))
    this.session = session
    return session
  }

  /** Opens the account's repo in a new session's worker and loads its items */
  private async initSession(
    session: WorkerSession,
    { accountId, vaultKey, onlineState, signal, isCurrent }: {
      accountId: string
      vaultKey: Parameters<SyncApi['initRepo']>[1]
      onlineState: boolean
      signal: AbortSignal
      isCurrent: () => boolean
    },
  ): Promise<void> {
    const { api } = session
    await untilAborted(
      api.initRepo(accountId, vaultKey, {
        authToken: getVaultSession() || null,
      }),
      signal,
    )
    // The bridge only forwards tokens once the session is ready, so this delivers one refreshed while
    // initRepo was running
    const authToken = getVaultSession()
    if (authToken) {
      await untilAborted(api.updateAuthToken(authToken), signal)
    }
    throwIfSuperseded(isCurrent)

    await untilAborted(api.setOnlineState(onlineState), signal)
    throwIfSuperseded(isCurrent)

    await untilAborted(api.bootstrapItems(), signal)
    this.healthMonitor.recordActivity()
    throwIfSuperseded(isCurrent)
  }

  private onRunReady(): void {
    const { session } = this
    if (!session) return
    this.callbacks.onReady?.()
    this.callbacks.onSyncWarning?.(null)
    this.watchHealth(session)
  }

  /** Health-checks a ready session, tearing it down if it crashes so the state can restart it */
  private watchHealth(session: WorkerSession): void {
    this.healthMonitor.setupWorkerHealthCheck({
      worker: session.worker,
      pingPort: session.pingPort,
      isCurrentWorker: () => this.session === session && this.state.phase.kind === 'ready',
      onCrash: (willRestart = true) => {
        if (this.session !== session) return
        session.close()
        this.session = null
        this.dispatch({ type: 'crashed', willRestart })
      },
    })
  }

  /**
   * Shuts the worker down, then clears the account's local data if asked (rule 5: the worker's Repo
   * closes before its storage is cleared). A close already in progress serves this one.
   */
  private async closeWorker(options: CloseOptions): Promise<void> {
    const { accountId, clearLocalData, onClosed } = options
    if (this.activeShutdown) {
      await this.activeShutdown
      onClosed?.()
      if (accountId && (clearLocalData || this.pendingShutdownClearAccounts.has(accountId))) {
        await this.clearLocalData(accountId)
      }
      return
    }

    const shutdownPromise = this.performClose(options)
    this.activeShutdown = shutdownPromise
    try {
      await shutdownPromise
    } finally {
      if (this.activeShutdown === shutdownPromise) {
        this.activeShutdown = null
      }
    }
  }

  private async performClose({ accountId, clearLocalData, internalRestart, onClosed }: CloseOptions): Promise<void> {
    const shouldClearLocalData = clearLocalData || Boolean(accountId && this.pendingShutdownClearAccounts.has(accountId))

    this.healthMonitor.stopWorkerHeartbeat()
    this.healthMonitor.resetCrashMetrics()

    const oldSession = this.session
    this.session = null

    this.callbacks.onShutdownCleanup?.({ internalRestart })

    if (oldSession) {
      try {
        await withTimeout(
          SYNC_TIMEOUTS.workerShutdown,
          signal => untilAborted(oldSession.api.shutdown({ clearLocalData: shouldClearLocalData }), signal),
          { reason: new Error('Sync worker shutdown timed out') },
        )
      } catch (err) {
        log.error('Failed to shut down worker cleanly:', err)
      }
      oldSession.close()
    }

    onClosed?.()

    if (shouldClearLocalData && accountId) {
      await this.clearLocalData(accountId)
    }
  }

  /** Clears the account's local data, throwing `LocalDataCleanupError` if any of it remains */
  private async clearLocalData(accountId: string): Promise<void> {
    try {
      await clearAccountLocalData(accountId)
    } finally {
      this.pendingShutdownClearAccounts.delete(accountId)
    }
  }
}

function throwIfSuperseded(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new AbortError('Initialization aborted')
}
