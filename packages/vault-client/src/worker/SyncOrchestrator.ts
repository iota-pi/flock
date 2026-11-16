import { LeaderElection, type LeaderElectionCallbacks } from './utils/LeaderElection'
import type { PollOutcome, SyncPoller } from './SyncPoller'
import type { SyncLogPuller } from './SyncLogPuller'
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
  puller: Pick<SyncLogPuller, 'loadState' | 'hasImmediatePendingPulls' | 'gapRepollDelay'>
  manifestSyncManager: Pick<ManifestSyncManager, 'sync' | 'abort' | 'waitForIdle'>
  manifestSyncIntervalMs?: number
  createLeaderElection?: (accountId: string, callbacks: LeaderElectionCallbacks) => LeaderElectionLike
  /** Called once the session holds new leadership */
  onLeaderChange?: (isLeader: boolean) => void
  /** Called when another tab also claims leadership, and when this tab is the only leader again */
  onLeaderOverlapChange?: (hasMultipleLeaders: boolean) => void
  /** Receives each poll's outcome */
  onPollResult?: (outcome: PollOutcome) => void
  /**
   * How often to poll while nothing is failing: `active` (10–15s) while the user is using one of the
   * account's visible tabs or changes just came from another device, `idle` (30s) while a tab is
   * visible, and `hidden` (5–10 min) while none is. Defaults to `idle`.
   */
  getCadence?: () => PollCadence
  /** When the next snapshot upload is due, which brings a poll forward if it's sooner */
  getSnapshotDueAt?: () => number | undefined
}

export type PollCadence = 'active' | 'idle' | 'hidden'

const DEFAULT_MANIFEST_SYNC_INTERVAL_MS = SYNC_TIMEOUTS.manifestSyncInterval

/** A whole number of milliseconds picked uniformly from `min` to `max` */
function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

interface PollDelay {
  delayMs: number
  /** Whether the delay was picked from a range, which spreads polls out already, so no jitter is added */
  isSpread: boolean
}

export class SyncOrchestrator {
  private leaderElection: LeaderElectionLike | null = null
  private pollingPausedForAuth = false

  private pendingFlush = false
  private lastPollFinishedAt = 0
  /** When the pending poll timer fires. Only meaningful while `pollTimer.isPending`. */
  private nextPollAt = 0
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

  /**
   * Brings the next poll forward to the active rate when activity starts while it's further off,
   * so the user doesn't wait out the rest of an idle interval. Never polls at once, and leaves
   * failure backoff alone.
   */
  onActivity(): void {
    if (this.isShutdown || !this.deps.session.isOnline || !this.deps.session.isLeader) return
    if (this.pollingPausedForAuth || this.pollBackoff.attempt > 0 || !this.pollTimer.isPending) return
    if (this.cadence !== 'active') return
    if (this.nextPollAt - Date.now() <= SYNC_TIMEOUTS.activePollMax) return
    this.schedulePollTimer(randomBetween(SYNC_TIMEOUTS.activePollMin, SYNC_TIMEOUTS.activePollMax), { jitter: false })
  }

  /**
   * Brings the next poll forward to when snapshots are due, if that's sooner. Leaves failure backoff
   * and an auth pause alone, and a poll in flight schedules the next one itself.
   */
  onSnapshotDue(): void {
    if (this.isShutdown || !this.deps.session.isOnline || !this.deps.session.isLeader) return
    if (this.pollingPausedForAuth || this.pollBackoff.attempt > 0 || !this.pollTimer.isPending) return
    const dueDelay = this.snapshotDueDelay
    if (dueDelay === undefined || Date.now() + dueDelay >= this.nextPollAt) return
    this.schedulePollTimer(dueDelay, { jitter: false })
  }

  /** How long until snapshots are due, if any are */
  private get snapshotDueDelay(): number | undefined {
    const dueAt = this.deps.getSnapshotDueAt?.()
    return dueAt === undefined ? undefined : Math.max(0, dueAt - Date.now())
  }

  /**
   * Runs a poll now, after the one in flight if there is one, and resolves once it has finished. Polls
   * even while backing off or paused for auth, as `flush` does.
   */
  async pollNow(): Promise<void> {
    if (this.isShutdown || !this.deps.session.isLeader) return
    this.pollingPausedForAuth = false
    while (this.pollGuard.isRunning) {
      await this.pollGuard.waitForRunning()
    }
    await this.executeWrappedPoll(true)
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

  private schedulePollTimer(delayMs: number, options?: { jitter?: boolean }): void {
    if (!this.canPoll()) {
      return
    }

    const scheduledDelay = options?.jitter === false ? delayMs : this.pollBackoff.applyJitter(delayMs)
    this.nextPollAt = Date.now() + scheduledDelay
    this.pollTimer.schedule(scheduledDelay, () => {
      fireAndForget(this.executeWrappedPoll(), 'SyncOrchestrator:executeWrappedPoll')
    })
  }

  private get cadence(): PollCadence {
    return this.deps.getCadence?.() ?? 'idle'
  }

  /** The backoff delay after failures, otherwise the interval for the current cadence */
  private get nextPollDelay(): PollDelay {
    if (this.pollBackoff.attempt > 0) {
      return { delayMs: this.pollBackoff.currentBaseDelay, isSpread: false }
    }
    switch (this.cadence) {
      case 'active':
        return { delayMs: randomBetween(SYNC_TIMEOUTS.activePollMin, SYNC_TIMEOUTS.activePollMax), isSpread: true }
      case 'hidden':
        return { delayMs: randomBetween(SYNC_TIMEOUTS.hiddenPollMin, SYNC_TIMEOUTS.hiddenPollMax), isSpread: true }
      case 'idle':
        return { delayMs: this.pollBackoff.currentBaseDelay, isSpread: false }
    }
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
      || (outcome === 'success' && this.deps.puller.hasImmediatePendingPulls())
    )
    const gapDelay = outcome === 'success' ? this.deps.puller.gapRepollDelay : undefined
    // Snapshots wait out failure backoff with everything else
    const snapshotDelay = outcome === 'failure' ? undefined : this.snapshotDueDelay
    const next = this.nextPollDelay
    if (pollNow) {
      this.schedulePollTimer(0)
    } else if (gapDelay !== undefined && gapDelay < next.delayMs && (snapshotDelay === undefined || gapDelay <= snapshotDelay)) {
      this.schedulePollTimer(gapDelay)
    } else if (snapshotDelay !== undefined && snapshotDelay < next.delayMs) {
      this.schedulePollTimer(snapshotDelay, { jitter: false })
    } else {
      this.schedulePollTimer(next.delayMs, { jitter: !next.isSpread })
    }
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
      await this.deps.puller.loadState()
    } catch (error) {
      log.error('Failed to reload the log state on leader promotion', error)
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
