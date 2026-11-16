import { LeaderElection, type LeaderElectionCallbacks } from './utils/LeaderElection'
import type { PollOutcome, SyncPoller } from './SyncPoller'
import type { SyncLogPuller } from './SyncLogPuller'
import type { ManifestSyncManager } from './ManifestSyncManager'
import type { SyncSessionState } from './SyncSessionState'
import type { ClientEventHub } from './SyncEventHub'
import {
  INITIAL_POLL_STATE,
  transitionPoll,
  type PollCadence,
  type PollEffect,
  type PollEvent,
  type PollResult,
  type PollState,
} from './pollSchedule'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { AbortableRun } from '../utils/AbortableRun'
import { RetryTimer } from '../utils/RetryTimer'
import { checkAlive, isAbortError, withTimeout } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { fireAndForget } from '../utils/fireAndForget'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncOrchestrator')

type LeaderElectionLike = Pick<LeaderElection, 'acquire' | 'release' | 'claimLeadership'> &
  Partial<Pick<LeaderElection, 'isLockHeldElsewhere'>>

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

const DEFAULT_MANIFEST_SYNC_INTERVAL_MS = SYNC_TIMEOUTS.manifestSyncInterval
/** How often `settleLeadership` looks at the lock again, in case another tab took it meanwhile */
const LEADERSHIP_RECHECK_MS = 100

/**
 * Runs the leader's sync: leader election, the periodic manifest sync, and polls on the schedule
 * `transitionPoll` decides. This class owns the timers and runs the poll; every decision about when
 * to poll is a transition of `pollState` (see `pollSchedule.ts`).
 */
export class SyncOrchestrator {
  private leaderElection: LeaderElectionLike | null = null

  private pollState: PollState = INITIAL_POLL_STATE
  /** Identifies the poll whose result counts. Starting or aborting a poll makes earlier results stale. */
  private pollRunId = 0
  /** The latest poll, which settles after every earlier one */
  private pollInFlight: Promise<void> | null = null
  private readonly cursorReloadGuard = new SingleFlightGuard<void>()
  private readonly pollRun = new AbortableRun(() => this.isOperational)

  /** Armed while the schedule is `waiting` */
  private readonly pollTimer = new RetryTimer()
  /** Armed while a flush is queued, so flushes made in the same turn share one poll */
  private readonly flushTimer = new RetryTimer()

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

  /** Moves the poll schedule on by `event`, arms the timers its new state needs and carries out its effects */
  private dispatch(event: PollEvent): void {
    const previous = this.pollState
    const { state, effects } = transitionPoll(previous, event, {
      now: Date.now(),
      isOperational: this.isOperational,
      cadence: this.deps.getCadence?.() ?? 'idle',
      snapshotDueAt: this.deps.getSnapshotDueAt?.(),
      random: Math.random,
    })
    this.pollState = state

    if (state.phase.kind !== 'waiting') {
      this.pollTimer.cancel()
    } else if (state.phase !== previous.phase) {
      this.pollTimer.schedule(state.phase.until - Date.now(), () => this.dispatch({ type: 'timerFired' }))
    }
    if (!state.flushQueued) {
      this.flushTimer.cancel()
    } else if (!previous.flushQueued) {
      this.flushTimer.schedule(0, () => this.dispatch({ type: 'flushBatch' }))
    }

    for (const effect of effects) {
      this.runEffect(effect)
    }
  }

  private runEffect(effect: PollEffect): void {
    try {
      switch (effect.type) {
        case 'startPoll':
          this.startPoll()
          break
        case 'abortPoll':
          this.pollRunId += 1
          this.pollRun.abort()
          break
        case 'reportAuthFailure':
          this.deps.clientEventHub.emit({
            type: 'authFailure',
            message: 'Sync paused: your session has expired. Please sign in again.',
          })
          break
        case 'reportResult':
          this.deps.onPollResult?.(effect.outcome)
          break
      }
    } catch (error) {
      log.error(`Poll effect ${effect.type} failed:`, error)
    }
  }

  /**
   * Runs a poll once the previous one has settled, which an aborted poll that ignores its signal may
   * not have yet, and reports its result unless a later start or abort made it stale.
   */
  private startPoll(): void {
    this.pollRunId += 1
    const runId = this.pollRunId
    const previous = this.pollInFlight
    const run = (async () => {
      await previous
      if (runId !== this.pollRunId) return
      const result = await this.runPoll()
      if (runId !== this.pollRunId || !this.isOperational) return
      this.dispatch({
        type: 'pollFinished',
        result,
        hasImmediatePendingPulls: result === 'success' && this.deps.puller.hasImmediatePendingPulls(),
        gapRepollDelay: result === 'success' ? this.deps.puller.gapRepollDelay : undefined,
      })
    })()
    const tracked: Promise<void> = run
      .catch(error => {
        log.error('Error running a poll:', error)
      })
      .finally(() => {
        if (this.pollInFlight === tracked) this.pollInFlight = null
      })
    this.pollInFlight = tracked
  }

  private async runPoll(): Promise<PollResult> {
    try {
      return await this.pollRun.run(async signal => {
        if (this.cursorReloadGuard.isRunning) {
          await this.cursorReloadGuard.waitForRunning()
        }
        checkAlive(signal, () => this.isOperational)
        const outcome = await this.deps.poller.executePoll(signal)
        checkAlive(signal, () => this.isOperational)
        return outcome
      })
    } catch (error) {
      if (isAbortError(error)) return 'aborted'
      return classifySyncError(error).isAuth ? 'auth-failure' : 'failure'
    }
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

  /**
   * Resolves whether this tab leads. While its lock request is still pending and no other tab holds
   * the lock, it waits up to `timeoutMs` for the grant. A tab that only learns it leads later runs its
   * own manifest sync then.
   */
  async settleLeadership(timeoutMs: number = SYNC_TIMEOUTS.leadershipSettle): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.deps.session.isLeader) return true
      if (this.isShutdown || !this.leaderElection) return false
      try {
        if (await this.leaderElection.isLockHeldElsewhere?.()) return this.deps.session.isLeader
      } catch (error) {
        log.warn('Could not check which tab holds the leader lock', error)
        return this.deps.session.isLeader
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) return this.deps.session.isLeader
      try {
        await withTimeout(Math.min(remaining, LEADERSHIP_RECHECK_MS), signal => this.deps.session.whenLeader(signal))
      } catch (error) {
        if (!isAbortError(error)) throw error
      }
    }
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
  private startSyncing(options?: { resetBackoff?: boolean }): void {
    this.startPolling(options)
    this.startPeriodicManifestSync()
    fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
  }

  /** Cancels scheduled and in-flight polls and manifest syncs. */
  private stopSyncing(): void {
    this.dispatch({ type: 'stop' })
    this.stopPeriodicManifestSync()
    this.deps.manifestSyncManager.abort()
  }

  /** Polls now, or right after the poll in flight */
  private startPolling(options?: { resetBackoff?: boolean }): void {
    if (this.isShutdown || !this.deps.session.isLeader) return
    this.dispatch({ type: 'start', resetBackoff: options?.resetBackoff })
  }

  /** Stops syncing when the device goes offline, and resumes when it's back. The session holds the state. */
  onOnlineStateChange(): void {
    if (!this.deps.session.isOnline) {
      this.stopSyncing()
      return
    }

    if (this.deps.session.isLeader) {
      this.startSyncing({ resetBackoff: true })
    }
  }

  /**
   * Polls now when the user comes back to one of the account's tabs, unless a poll is running or one
   * finished in the last `foregroundPollMinGap`. Backoff after failures resets too: the connection
   * may be back without an `online` event (captive portal, flaky network, a phone waking). Also runs
   * a manifest sync, which skips itself if one finished in the last `manifestSyncMinGap`.
   */
  onForeground(): void {
    if (!this.isOperational) return
    fireAndForget(this.triggerManifestSync(), 'SyncOrchestrator:triggerManifestSync')
    this.dispatch({ type: 'foreground' })
  }

  /**
   * Brings the next poll forward to the active rate when activity starts while it's further off,
   * so the user doesn't wait out the rest of an idle interval. Never polls at once, and leaves
   * failure backoff alone.
   */
  onActivity(): void {
    this.dispatch({ type: 'activity' })
  }

  /**
   * Brings the next poll forward to when snapshots are due, if that's sooner. Leaves failure backoff
   * and an auth pause alone, and a poll in flight schedules the next one itself.
   */
  onSnapshotDue(): void {
    this.dispatch({ type: 'snapshotDue' })
  }

  /**
   * Runs a poll now, after the one in flight if there is one, and resolves once it has finished. Polls
   * even while backing off or paused for auth, as `flush` does.
   */
  async pollNow(): Promise<void> {
    if (this.isShutdown || !this.deps.session.isLeader) return
    while (this.pollInFlight) {
      await this.pollInFlight
    }
    this.dispatch({ type: 'pollNow' })
    await this.pollInFlight
  }

  /** Polls soon to push local changes, batching flushes made in the same turn into one poll */
  flush(): void {
    if (this.isShutdown) return
    this.dispatch({ type: 'flush' })
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
    await this.pollInFlight
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
