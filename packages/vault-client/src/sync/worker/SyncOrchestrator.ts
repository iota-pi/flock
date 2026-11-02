import { LeaderElection, type LeaderElectionCallbacks } from './utils/LeaderElection'
import type { PollOutcome } from './SyncPoller'
import type { SyncSessionState } from './SyncSessionState'
import { ClientEventHub } from './SyncEventHub'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AbortableRun } from '../utils/AbortableRun'
import { RetryStrategy, DEFAULT_POLL_BACKOFF_DELAYS } from '../utils/RetryStrategy'
import { RetryTimer } from '../utils/RetryTimer'
import { checkAlive, isAbortError } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { fireAndForget } from '../utils/fireAndForget'
import type { ItemId } from '@vault/shared'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncOrchestrator')

export interface LeaderElectionLike {
  acquire: () => Promise<void>
  release: () => void
  claimLeadership: () => void
}

export interface SyncPollerLike {
  executePoll: (signal: AbortSignal) => Promise<PollOutcome>
}

export interface SyncPullQueueManagerLike {
  loadCursors: () => Promise<void>
  hasImmediatePendingPulls: () => boolean
}

export interface ManifestSyncManagerLike {
  sync: (force?: boolean) => Promise<{ added: ItemId[] }>
  abort: () => void
  waitForIdle: () => Promise<void>
}

export interface SyncOrchestratorDeps {
  accountId: string
  /** The orchestrator records leadership here, as leader election grants and revokes it */
  session: SyncSessionState
  poller: SyncPollerLike
  clientEventHub: ClientEventHub
  pullQueueManager: SyncPullQueueManagerLike
  manifestSyncManager: ManifestSyncManagerLike
  manifestSyncIntervalMs?: number
  createLeaderElection?: (accountId: string, callbacks: LeaderElectionCallbacks) => LeaderElectionLike
  /** Called once the session holds new leadership */
  onLeaderChange?: (isLeader: boolean) => void
  /** Called when another tab also claims leadership, and when this tab is the only leader again */
  onLeaderOverlapChange?: (hasMultipleLeaders: boolean) => void
  /** Receives each poll's outcome */
  onPollResult?: (outcome: PollOutcome) => void
}

const DEFAULT_MANIFEST_SYNC_INTERVAL_MS = SYNC_TIMEOUTS.manifestSyncInterval

export class SyncOrchestrator {
  private leaderElection: LeaderElectionLike | null = null
  private pollingPausedForAuth = false

  private pendingFlush = false
  private readonly pollGuard = new SingleFlightGuard<void>()
  private readonly cursorReloadGuard = new SingleFlightGuard<void>()
  private readonly pollRun = new AbortableRun(() => this.isOperational)
  private readonly poller: SyncPollerLike

  private readonly pollTimer = new RetryTimer()
  private readonly syncBatchTimer = new RetryTimer()
  private readonly pollBackoff = new RetryStrategy({
    delays: DEFAULT_POLL_BACKOFF_DELAYS,
    jitter: { factor: 0.25, maxJitterMs: 15000 },
  })

  private manifestSyncIntervalId: number | null = null
  private readonly manifestSyncIntervalMs: number
  private readonly manifestSyncManager: ManifestSyncManagerLike

  private readonly accountId: string
  private readonly session: SyncSessionState
  private readonly clientEventHub: ClientEventHub
  private readonly pullQueueManager: SyncPullQueueManagerLike
  private readonly createLeaderElection?: SyncOrchestratorDeps['createLeaderElection']
  private readonly onLeaderChange?: (isLeader: boolean) => void
  private readonly onLeaderOverlapChange?: (hasMultipleLeaders: boolean) => void
  private readonly onPollResult?: (outcome: PollOutcome) => void

  constructor(deps: SyncOrchestratorDeps) {
    this.accountId = deps.accountId
    this.session = deps.session
    this.clientEventHub = deps.clientEventHub
    this.pullQueueManager = deps.pullQueueManager
    this.createLeaderElection = deps.createLeaderElection
    this.onLeaderChange = deps.onLeaderChange
    this.onLeaderOverlapChange = deps.onLeaderOverlapChange
    this.onPollResult = deps.onPollResult
    this.poller = deps.poller
    this.manifestSyncManager = deps.manifestSyncManager
    this.manifestSyncIntervalMs = deps.manifestSyncIntervalMs ?? DEFAULT_MANIFEST_SYNC_INTERVAL_MS
  }

  get isOperational(): boolean {
    return this.session.isOperational
  }

  private get isShutdown(): boolean {
    return this.session.isShutdown
  }

  private canPoll(force = false): boolean {
    return this.isOperational && (force || !this.pollingPausedForAuth)
  }

  private abortPoll(): void {
    this.pollRun.abort()
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
        this.onLeaderOverlapChange?.(true)
      },
      onSoleLeaderRestored: () => {
        this.onLeaderOverlapChange?.(false)
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

  setLeader(isLeader: boolean): void {
    if (!this.session.setLeader(isLeader)) {
      return
    }
    this.onLeaderChange?.(isLeader)

    if (isLeader) {
      fireAndForget(this.cursorReloadGuard.run(() => this.reloadCursors()), 'SyncOrchestrator:reloadCursors')
      if (this.session.isOnline) {
        this.startSyncing()
      } else {
        this.startPolling()
      }
    } else {
      this.cursorReloadGuard.clear()
      this.stopSyncing()
    }
  }

  /** Polls now and starts the periodic manifest sync with an immediate run. */
  private startSyncing(): void {
    this.startPolling()
    this.startPeriodicManifestSync()
    fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
  }

  /** Cancels scheduled and in-flight polls and manifest syncs. */
  private stopSyncing(): void {
    this.stopPolling()
    this.stopPeriodicManifestSync()
    this.abortPoll()
    this.manifestSyncManager.abort()
  }

  /** Stops syncing when the device goes offline, and resumes when it's back. The session holds the state. */
  onOnlineStateChange(): void {
    if (!this.session.isOnline) {
      this.stopSyncing()
      return
    }

    if (this.session.isLeader) {
      this.pollBackoff.reset()
      this.startSyncing()
    }
  }

  flush(): void {
    if (this.isShutdown) return
    this.pollingPausedForAuth = false
    if (!this.syncBatchTimer.isPending) {
      this.syncBatchTimer.schedule(0, () => fireAndForget(this.flushSyncBatch(), 'SyncOrchestrator:flushSyncBatch'))
    }
  }

  private async flushSyncBatch(): Promise<void> {
    try {
      if (this.pollGuard.isRunning) {
        this.pendingFlush = true
        return
      }

      if (this.pollBackoff.attempt > 0) {
        if (!this.pollTimer.isPending) {
          this.schedulePollTimer(this.pollBackoff.currentBaseDelay)
        }
        return
      }

      fireAndForget(this.executeWrappedPoll(true), 'SyncOrchestrator:executeWrappedPoll')
    } catch (err) {
      log.error('Error during flushSyncBatch:', err)
    }
  }

  /** Polls now, or right after the poll in flight */
  private startPolling(): void {
    if (this.isShutdown) return
    this.stopPolling()

    if (!this.session.isLeader) {
      return
    }

    this.pollingPausedForAuth = false

    if (!this.pollGuard.isRunning) {
      fireAndForget(this.executeWrappedPoll(true), 'SyncOrchestrator:executeWrappedPoll')
    } else {
      this.pendingFlush = true
    }
  }

  private stopPolling(): void {
    this.pollTimer.cancel()
    if (this.syncBatchTimer.isPending) {
      this.syncBatchTimer.cancel()
      if (!this.isShutdown) {
        this.pendingFlush = true
      }
    }
  }

  private schedulePollTimer(delayMs: number): void {
    if (!this.canPoll()) {
      return
    }

    this.pollTimer.schedule(this.pollBackoff.applyJitter(delayMs), () => {
      fireAndForget(this.executeWrappedPoll(), 'SyncOrchestrator:executeWrappedPoll')
    })
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

    const pollNow = outcome !== 'failure' && (
      wasFlushPending
      || (outcome === 'success' && this.pullQueueManager.hasImmediatePendingPulls())
    )
    this.schedulePollTimer(pollNow ? 0 : this.pollBackoff.currentBaseDelay)
    // Reported once the next poll is scheduled, so a failing receiver can't stop polling
    this.onPollResult?.(outcome)
  }

  private handlePollError(error: unknown): void {
    if (isAbortError(error) || !this.isOperational) {
      return
    }

    if (classifySyncError(error).isAuth) {
      this.handleAuthFailure()
      return
    }

    this.scheduleNextPoll('failure')
  }

  /** Pauses polling until the next flush or restart, and tells the app the session has expired. */
  private handleAuthFailure(): void {
    this.pollingPausedForAuth = true
    this.stopPolling()
    this.clientEventHub.emit({
      type: 'authFailure',
      message: 'Sync paused: your session has expired. Please sign in again.',
    })
    this.onPollResult?.('auth-failure')
  }

  private async executeWrappedPoll(force = false): Promise<void> {
    try {
      if (!this.canPoll(force) || this.pollGuard.isRunning) return

      await this.pollGuard.run(async () => {
        let outcome: PollOutcome
        try {
          outcome = await this.pollRun.run(async signal => {
            if (this.cursorReloadGuard.isRunning) {
              await this.cursorReloadGuard.waitForRunning()
            }
            checkAlive(signal, () => this.isOperational)

            const result = await this.poller.executePoll(signal)
            checkAlive(signal, () => this.isOperational)
            return result
          })
        } catch (err) {
          if (isAbortError(err)) {
            return
          }
          this.handlePollError(err)
          return
        }

        if (!this.isOperational) {
          return
        }

        if (outcome === 'auth-failure') {
          this.handleAuthFailure()
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

  /** Stops polling and gives up leadership. The context has already marked the session shut down. */
  async shutdown(): Promise<void> {
    this.setLeader(false)
    if (this.leaderElection) {
      this.leaderElection.release()
      this.leaderElection = null
    }
    this.stopSyncing()
    await this.pollGuard.waitForRunning()
    await this.manifestSyncManager.waitForIdle()
  }

  private startPeriodicManifestSync(): void {
    if (!this.isOperational) {
      return
    }
    this.stopPeriodicManifestSync()
    this.manifestSyncIntervalId = self.setInterval(() => {
      fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
    }, this.manifestSyncIntervalMs) as unknown as number
  }

  private stopPeriodicManifestSync(): void {
    if (this.manifestSyncIntervalId !== null) {
      self.clearInterval(this.manifestSyncIntervalId)
      this.manifestSyncIntervalId = null
    }
  }

  /** The manifest sync manager runs one sync at a time and aborts it when `stopSyncing` calls `abort` */
  private async triggerManifestSync(): Promise<void> {
    if (!this.isOperational) {
      return
    }
    try {
      await this.manifestSyncManager.sync(false)
    } catch (error) {
      log.warn('Manifest sync failed', error)
    }
  }
}
