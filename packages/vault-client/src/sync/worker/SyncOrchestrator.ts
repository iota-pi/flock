import { LeaderElection, type LeaderElectionCallbacks } from './utils/LeaderElection'
import type { SyncMessageBroker } from './SyncMessageBroker'
import type { PollOutcome } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { RetryStrategy, DEFAULT_POLL_BACKOFF_DELAYS } from '../utils/RetryStrategy'
import { checkAlive, isAbortError } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { fireAndForget } from '../utils/fireAndForget'
import type { ItemId } from '@vault/shared'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { LifecycleAware } from './ServiceLifecycleManager'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncOrchestrator')

export interface LeaderElectionLike {
  acquire: () => Promise<void>
  release: () => void
  claimLeadership: () => void
}

export interface SyncPollerLike {
  executePoll: () => Promise<PollOutcome>
  abort: () => void
}

export interface SyncPullQueueManagerLike {
  loadCursors: () => Promise<void>
  hasImmediatePendingPulls: () => boolean
}

export interface ManifestSyncManagerLike {
  sync: (force?: boolean, signal?: AbortSignal) => Promise<{ added: ItemId[] }>
  abort: () => void
}

export interface SyncOrchestratorDeps {
  accountId: string
  broker: SyncMessageBroker
  clientEventHub: ClientEventHub
  internalEventHub: WorkerInternalEventHub
  pullQueueManager: SyncPullQueueManagerLike
  manifestSyncManager: ManifestSyncManagerLike
  manifestSyncIntervalMs?: number
  createLeaderElection?: (accountId: string, callbacks: LeaderElectionCallbacks) => LeaderElectionLike
}

const DEFAULT_MANIFEST_SYNC_INTERVAL_MS = SYNC_TIMEOUTS.manifestSyncInterval

export class SyncOrchestrator implements LifecycleAware {
  readonly lifecycleName = 'SyncOrchestrator'
  private leaderElection: LeaderElectionLike | null = null
  private isOnline = true
  private isLeader = false
  private pollingPausedForAuth = false
  private isShutdown = false

  async onLifecycleStart(): Promise<void> {
    await this.start()
  }

  async onLifecycleStop(_?: { clearLocalData?: boolean }): Promise<void> {
    await this.shutdown()
  }

  private pendingFlush = false
  private readonly pollGuard = new SingleFlightGuard<void>()
  private readonly cursorReloadGuard = new SingleFlightGuard<void>()
  private pollAbortController: AbortController | null = null
  private manifestSyncAbortController: AbortController | null = null
  private poller: SyncPollerLike

  private pollIntervalId: number | null = null
  private syncBatchTimeout: number | null = null
  private readonly pollBackoff = new RetryStrategy({
    delays: DEFAULT_POLL_BACKOFF_DELAYS,
    jitter: { factor: 0.25, maxJitterMs: 15000 },
  })

  private manifestSyncIntervalId: number | null = null
  private readonly manifestSyncIntervalMs: number
  private readonly manifestSyncGuard = new SingleFlightGuard<void>()
  private readonly manifestSyncManager: ManifestSyncManagerLike

  private unsubscribeInternalEvents: (() => void) | null = null

  private readonly accountId: string
  private readonly broker: SyncMessageBroker
  private readonly clientEventHub: ClientEventHub
  private readonly internalEventHub: WorkerInternalEventHub
  private readonly pullQueueManager: SyncPullQueueManagerLike
  private readonly createLeaderElection?: SyncOrchestratorDeps['createLeaderElection']

  constructor(deps: SyncOrchestratorDeps) {
    this.accountId = deps.accountId
    this.broker = deps.broker
    this.clientEventHub = deps.clientEventHub
    this.internalEventHub = deps.internalEventHub
    this.pullQueueManager = deps.pullQueueManager
    this.createLeaderElection = deps.createLeaderElection
    this.poller = deps.broker.poller
    this.manifestSyncManager = deps.manifestSyncManager
    this.manifestSyncIntervalMs = deps.manifestSyncIntervalMs ?? DEFAULT_MANIFEST_SYNC_INTERVAL_MS
    this.unsubscribeInternalEvents = this.internalEventHub.subscribe(event => {
      if (event.type === 'flushNeeded') {
        this.flush()
      }
    })
    // Sync initial states with the broker
    this.broker.setOnlineState(this.isOnline)
    this.broker.setSendEnabled(this.isLeader)
  }

  get isOperational(): boolean {
    return !this.isShutdown && this.isOnline && this.isLeader
  }

  get isPolling(): boolean {
    return this.pollGuard.isRunning
  }

  get hasPendingFlush(): boolean {
    return this.pendingFlush
  }

  get hasScheduledPoll(): boolean {
    return this.pollIntervalId !== null
  }

  private canPoll(force = false): boolean {
    return this.isOperational && (force || !this.pollingPausedForAuth)
  }

  private abortPoll(): void {
    if (this.pollAbortController) {
      this.pollAbortController.abort()
      this.pollAbortController = null
      this.poller.abort()
    }
  }

  private abortManifestSync(): void {
    if (this.manifestSyncAbortController) {
      this.manifestSyncAbortController.abort()
      this.manifestSyncAbortController = null
    }
    this.manifestSyncManager.abort()
  }

  async start(): Promise<void> {
    const callbacks: LeaderElectionCallbacks = {
      onLeaderGranted: () => {
        this.setLeader(true)
      },
      onLeaderRevoked: () => {
        this.setLeader(false)
      },
      onMultipleLeadersDetected: () => {
        this.internalEventHub.emit({ type: 'multipleLeadersDetected' })
      },
      onSoleLeaderRestored: () => {
        this.internalEventHub.emit({ type: 'soleLeaderRestored' })
      },
      onLeaderConflict: (isConflict: boolean) => {
        this.clientEventHub.emit({ type: 'leaderConflict', hasConflict: isConflict })
      },
    }
    this.leaderElection = this.createLeaderElection
      ? this.createLeaderElection(this.accountId, callbacks)
      : new LeaderElection(this.accountId, callbacks)
    fireAndForget(this.leaderElection.acquire(), 'SyncOrchestrator:leaderElection:acquire')
  }

  claimLeader(): void {
    this.leaderElection?.claimLeadership()
  }

  get leader(): boolean {
    return this.isLeader
  }

  get online(): boolean {
    return this.isOnline
  }

  setLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader
    this.broker.setSendEnabled(isLeader)
    this.internalEventHub.emit({ type: 'leaderChange', isLeader })

    if (isLeader) {
      fireAndForget(this.cursorReloadGuard.run(() => this.reloadCursors()), 'SyncOrchestrator:reloadCursors')
      this.startPolling(true)
      if (this.isOnline) {
        this.startPeriodicManifestSync()
        fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
      }
    } else {
      this.cursorReloadGuard.clear()
      this.stopPolling()
      this.stopPeriodicManifestSync()
      this.abortPoll()
      this.abortManifestSync()
    }
  }

  setOnlineState(isOnline: boolean): void {
    if (this.isOnline === isOnline) {
      return
    }
    this.isOnline = isOnline
    this.broker.setOnlineState(isOnline)

    if (!isOnline) {
      this.stopPolling()
      this.stopPeriodicManifestSync()
      this.abortPoll()
      this.abortManifestSync()
      return
    }

    if (this.isLeader) {
      this.pollBackoff.reset()
      this.startPolling(true)
      this.startPeriodicManifestSync()
      fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
    }
  }

  flush(): void {
    if (this.isShutdown) return
    this.pollingPausedForAuth = false
    if (this.syncBatchTimeout === null) {
      this.syncBatchTimeout = self.setTimeout(
        () => fireAndForget(this.flushSyncBatch(), 'SyncOrchestrator:flushSyncBatch'),
        0
      )
    }
  }

  private async flushSyncBatch(): Promise<void> {
    try {
      this.syncBatchTimeout = null
      if (this.pollGuard.isRunning) {
        this.pendingFlush = true
        return
      }

      if (this.pollBackoff.attempt > 0) {
        if (this.pollIntervalId === null) {
          this.schedulePollTimer(this.pollBackoff.currentBaseDelay)
        }
        return
      }

      fireAndForget(this.executeWrappedPoll(true), 'SyncOrchestrator:executeWrappedPoll')
    } catch (err) {
      log.error('Error during flushSyncBatch:', err)
    }
  }

  startPolling(immediate?: boolean): void {
    if (this.isShutdown) return
    this.stopPolling()

    if (!this.isLeader) {
      return
    }

    this.pollingPausedForAuth = false

    if (immediate) {
      if (!this.pollGuard.isRunning) {
        fireAndForget(this.executeWrappedPoll(true), 'SyncOrchestrator:executeWrappedPoll')
      } else {
        this.pendingFlush = true
      }
    } else {
      this.schedulePollTimer(this.pollBackoff.currentBaseDelay)
    }
  }

  stopPolling(): void {
    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
      this.pollIntervalId = null
    }
    if (this.syncBatchTimeout) {
      self.clearTimeout(this.syncBatchTimeout)
      this.syncBatchTimeout = null
      if (!this.isShutdown) {
        this.pendingFlush = true
      }
    }
  }

  private schedulePollTimer(delayMs: number): void {
    if (!this.canPoll()) {
      return
    }

    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
    }

    const jitteredDelayMs = this.pollBackoff.applyJitter(delayMs)
    this.pollIntervalId = self.setTimeout(() => {
      this.pollIntervalId = null
      fireAndForget(this.executeWrappedPoll(), 'SyncOrchestrator:executeWrappedPoll')
    }, jitteredDelayMs)
  }

  private scheduleNextPoll(outcome: PollOutcome): void {
    const wasFlushPending = this.pendingFlush
    this.pendingFlush = false

    if (outcome === 'failure') {
      this.pollBackoff.increment({ clampToLast: true })
    } else if (outcome === 'success') {
      this.pollBackoff.reset()
      this.pollingPausedForAuth = false
    }

    this.internalEventHub.emit({ type: 'pollResult', outcome })

    const pollNow = outcome !== 'failure' && (
      wasFlushPending
      || (outcome === 'success' && this.pullQueueManager.hasImmediatePendingPulls())
    )
    this.schedulePollTimer(pollNow ? 0 : this.pollBackoff.currentBaseDelay)
  }

  private handlePollError(error: unknown): void {
    if (isAbortError(error) || !this.isOperational) {
      return
    }

    const isAuth = error === 'auth-failure' || classifySyncError(error).isAuth
    if (isAuth) {
      this.pollingPausedForAuth = true
      this.stopPolling()
      this.clientEventHub.emit({
        type: 'authFailure',
        message: 'Sync paused: your session has expired. Please sign in again.',
      })
      this.internalEventHub.emit({ type: 'pollResult', outcome: 'auth-failure' })
      return
    }

    this.scheduleNextPoll('failure')
  }

  private async executeWrappedPoll(force = false): Promise<void> {
    try {
      if (!this.canPoll(force) || this.pollGuard.isRunning) return

      await this.pollGuard.run(async () => {
        const abortController = new AbortController()
        this.pollAbortController = abortController
        const { signal } = abortController

        let outcome: PollOutcome
        try {
          if (this.cursorReloadGuard.isRunning) {
            await this.cursorReloadGuard.waitForRunning()
          }
          checkAlive(signal, () => this.isOperational)

          outcome = await this.poller.executePoll()
          checkAlive(signal, () => this.isOperational)
        } catch (err) {
          if (signal.aborted || isAbortError(err) || !this.isOperational) {
            return
          }
          this.handlePollError(err)
          return
        } finally {
          if (this.pollAbortController === abortController) {
            this.pollAbortController = null
          }
        }

        if (signal.aborted || !this.isOperational) {
          return
        }

        if (outcome === 'auth-failure') {
          this.handlePollError(outcome)
          return
        }

        this.scheduleNextPoll(outcome)
      }, {
        onCoalesce: () => {
          this.pendingFlush = true
        },
      })
    } catch (err) {
      if (!isAbortError(err)) {
        log.error('Error during executeWrappedPoll:', err)
      }
    }
  }

  private async reloadCursors(): Promise<void> {
    try {
      await this.pullQueueManager.loadCursors()
    } catch (error) {
      log.error('Failed to reload cursors on leader promotion', error)
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true
    if (this.unsubscribeInternalEvents) {
      this.unsubscribeInternalEvents()
      this.unsubscribeInternalEvents = null
    }
    const wasPolling = this.pollAbortController !== null
    const wasLeader = this.isLeader
    this.setLeader(false)
    if (this.leaderElection) {
      this.leaderElection.release()
      this.leaderElection = null
    }
    if (!wasLeader) {
      this.cursorReloadGuard.clear()
      this.stopPolling()
      this.stopPeriodicManifestSync()
      this.abortPoll()
      this.abortManifestSync()
    }
    if (!wasPolling) {
      this.poller.abort()
    }
    await this.pollGuard.waitForRunning()
    await this.manifestSyncGuard.waitForRunning()
  }

  startPeriodicManifestSync(): void {
    if (!this.isOperational) {
      return
    }
    this.stopPeriodicManifestSync()
    this.manifestSyncIntervalId = self.setInterval(() => {
      fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
    }, this.manifestSyncIntervalMs) as unknown as number
  }

  stopPeriodicManifestSync(): void {
    if (this.manifestSyncIntervalId !== null) {
      self.clearInterval(this.manifestSyncIntervalId)
      this.manifestSyncIntervalId = null
    }
  }

  async triggerManifestSync(force = false): Promise<void> {
    try {
      if (!this.isOperational) {
        return
      }
      return await this.manifestSyncGuard.run(async () => {
        const abortController = new AbortController()
        this.manifestSyncAbortController = abortController
        const { signal } = abortController
        try {
          checkAlive(signal, () => this.isOperational)
          await this.manifestSyncManager.sync(force, signal)
          checkAlive(signal, () => this.isOperational)
        } catch (error) {
          if (signal.aborted || isAbortError(error) || !this.isOperational) {
            return
          }
          log.warn('Manifest sync failed', error)
        } finally {
          if (this.manifestSyncAbortController === abortController) {
            this.manifestSyncAbortController = null
          }
        }
      })
    } catch (err) {
      if (!isAbortError(err)) {
        log.error('Error during triggerManifestSync:', err)
      }
    }
  }
}
