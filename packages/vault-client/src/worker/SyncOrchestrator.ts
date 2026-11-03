import { LeaderElection, type LeaderElectionCallbacks } from './utils/LeaderElection'
import type { PollOutcome, SyncPoller } from './SyncPoller'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import type { ManifestSyncManager } from './ManifestSyncManager'
import type { SyncSessionState } from './SyncSessionState'
import type { ClientEventHub } from './SyncEventHub'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AbortableRun } from '../utils/AbortableRun'
import { RetryStrategy, DEFAULT_POLL_BACKOFF_DELAYS } from '../utils/RetryStrategy'
import { RetryTimer } from '../utils/RetryTimer'
import { checkAlive, isAbortError } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { fireAndForget } from '../utils/fireAndForget'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncOrchestrator')

type LeaderElectionLike = Pick<LeaderElection, 'acquire' | 'release' | 'claimLeadership'>

export interface SyncOrchestratorDeps {
  accountId: string
  /** The orchestrator records leadership here, as leader election grants and revokes it */
  session: SyncSessionState
  poller: Pick<SyncPoller, 'executePoll'>
  clientEventHub: ClientEventHub
  pullQueueManager: Pick<SyncPullQueueManager, 'loadCursors' | 'hasImmediatePendingPulls'>
  manifestSyncManager: Pick<ManifestSyncManager, 'sync' | 'abort' | 'waitForIdle'>
  manifestSyncIntervalMs?: number
  createLeaderElection?: (accountId: string, callbacks: LeaderElectionCallbacks) => LeaderElectionLike
  /** Called once the session holds new leadership */
  onLeaderChange?: (isLeader: boolean) => void
  /** Called when another tab also claims leadership, and when this tab is the only leader again */
  onLeaderOverlapChange?: (hasMultipleLeaders: boolean) => void
  /** Receives each poll's outcome */
  onPollResult?: (outcome: PollOutcome) => void
  /** Whether any of the account's tabs is visible. Polls slow to `hiddenPollInterval` while none is. */
  isForeground?: () => boolean
}

const DEFAULT_MANIFEST_SYNC_INTERVAL_MS = SYNC_TIMEOUTS.manifestSyncInterval

export class SyncOrchestrator {
  private leaderElection: LeaderElectionLike | null = null
  private pollingPausedForAuth = false

  private pendingFlush = false
  private lastPollFinishedAt = 0
  private readonly pollGuard = new SingleFlightGuard<void>()
  private readonly cursorReloadGuard = new SingleFlightGuard<void>()
  private readonly pollRun = new AbortableRun(() => this.isOperational)

  private readonly pollTimer = new RetryTimer()
  private readonly syncBatchTimer = new RetryTimer()
  private readonly pollBackoff = new RetryStrategy({
    delays: DEFAULT_POLL_BACKOFF_DELAYS,
    jitter: { factor: 0.25, maxJitterMs: 15000 },
  })

  private manifestSyncIntervalId: ReturnType<typeof setInterval> | null = null
  private readonly manifestSyncIntervalMs: number


  constructor(private readonly deps: SyncOrchestratorDeps) {
    this.manifestSyncIntervalMs = deps.manifestSyncIntervalMs ?? DEFAULT_MANIFEST_SYNC_INTERVAL_MS
  }

  get isOperational(): boolean {
    return this.deps.session.isOperational
  }

  private get isShutdown(): boolean {
    return this.deps.session.isShutdown
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
        this.deps.onLeaderOverlapChange?.(true)
      },
      onSoleLeaderRestored: () => {
        this.deps.onLeaderOverlapChange?.(false)
      },
      onLeaderConflict: (isConflict: boolean) => {
        this.deps.clientEventHub.emit({ type: 'leaderConflict', hasConflict: isConflict })
      },
    }
    this.leaderElection = this.deps.createLeaderElection
      ? this.deps.createLeaderElection(this.deps.accountId, callbacks)
      : new LeaderElection(this.deps.accountId, callbacks)
    fireAndForget(this.leaderElection.acquire(), 'SyncOrchestrator:leaderElection:acquire')
  }

  claimLeader(): void {
    this.leaderElection?.claimLeadership()
  }

  setLeader(isLeader: boolean): void {
    if (!this.deps.session.setLeader(isLeader)) {
      return
    }
    this.deps.onLeaderChange?.(isLeader)

    if (isLeader) {
      fireAndForget(this.cursorReloadGuard.run(() => this.reloadCursors()), 'SyncOrchestrator:reloadCursors')
      if (this.deps.session.isOnline) {
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
    this.deps.manifestSyncManager.abort()
  }

  /** Stops syncing when the device goes offline, and resumes when it's back. The session holds the state. */
  onOnlineStateChange(): void {
    if (!this.deps.session.isOnline) {
      this.stopSyncing()
      return
    }

    if (this.deps.session.isLeader) {
      this.pollBackoff.reset()
      this.startSyncing()
    }
  }

  /**
   * Polls now when the user comes back to one of the account's tabs, unless a poll is running or one
   * finished in the last `foregroundPollMinGap`. Backoff after failures resets too: the connection
   * may be back without an `online` event (captive portal, flaky network, a phone waking). Also runs
   * a manifest sync, which skips itself if one finished in the last `manifestSyncMinGap`.
   */
  onForeground(): void {
    if (this.isShutdown || !this.deps.session.isOnline || !this.deps.session.isLeader) return
    fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
    if (this.pollingPausedForAuth || this.pollGuard.isRunning) return
    const isBackingOff = this.pollBackoff.attempt > 0
    if (!isBackingOff && Date.now() - this.lastPollFinishedAt < SYNC_TIMEOUTS.foregroundPollMinGap) return
    this.pollBackoff.reset()
    this.startPolling()
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

    if (!this.deps.session.isLeader) {
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

  /** The backoff delay after failures, otherwise the foreground or hidden interval */
  private get nextPollDelay(): number {
    if (this.pollBackoff.attempt > 0 || (this.deps.isForeground?.() ?? true)) {
      return this.pollBackoff.currentBaseDelay
    }
    return SYNC_TIMEOUTS.hiddenPollInterval
  }

  private scheduleNextPoll(outcome: PollOutcome): void {
    const wasFlushPending = this.pendingFlush
    this.pendingFlush = false
    this.lastPollFinishedAt = Date.now()

    if (outcome === 'failure') {
      this.pollBackoff.increment({ clampToLast: true })
    } else if (outcome === 'success') {
      this.pollBackoff.reset()
      this.pollingPausedForAuth = false
    }

    const pollNow = outcome !== 'failure' && (
      wasFlushPending
      || (outcome === 'success' && this.deps.pullQueueManager.hasImmediatePendingPulls())
    )
    this.schedulePollTimer(pollNow ? 0 : this.nextPollDelay)
    // Reported once the next poll is scheduled, so a failing receiver can't stop polling
    this.deps.onPollResult?.(outcome)
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
    this.deps.clientEventHub.emit({
      type: 'authFailure',
      message: 'Sync paused: your session has expired. Please sign in again.',
    })
    this.deps.onPollResult?.('auth-failure')
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

            const result = await this.deps.poller.executePoll(signal)
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
      await this.deps.pullQueueManager.loadCursors()
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
    await this.deps.manifestSyncManager.waitForIdle()
  }

  private startPeriodicManifestSync(): void {
    if (!this.isOperational) {
      return
    }
    this.stopPeriodicManifestSync()
    this.manifestSyncIntervalId = setInterval(() => {
      fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
    }, this.manifestSyncIntervalMs)
  }

  private stopPeriodicManifestSync(): void {
    if (this.manifestSyncIntervalId !== null) {
      clearInterval(this.manifestSyncIntervalId)
      this.manifestSyncIntervalId = null
    }
  }

  /** The manifest sync manager runs one sync at a time and aborts it when `stopSyncing` calls `abort` */
  private async triggerManifestSync(): Promise<void> {
    if (!this.isOperational) {
      return
    }
    try {
      await this.deps.manifestSyncManager.sync(false)
    } catch (error) {
      log.warn('Manifest sync failed', error)
    }
  }
}
