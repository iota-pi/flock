import type { PollOutcome, SyncPoller } from './SyncPoller'
import type { SyncLogPuller } from './SyncLogPuller'
import type { ManifestMode, ManifestPhaseResult, ManifestSyncManager } from './ManifestSyncManager'
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
import { AbortableRun } from '../utils/AbortableRun'
import { RetryTimer } from '../utils/RetryTimer'
import { checkAlive, isAbortError } from '../utils/abort'
import { classifySyncError } from '../utils/errorClassifier'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncOrchestrator')

export interface SyncOrchestratorDeps {
  session: SyncSessionState
  poller: Pick<SyncPoller, 'executePoll'>
  clientEventHub: ClientEventHub
  puller: Pick<SyncLogPuller, 'hasImmediatePendingPulls' | 'gapRepollDelay'>
  manifestSyncManager: Pick<ManifestSyncManager, 'request' | 'openTicket' | 'closeTicket' | 'getDueAt'>
  /** Receives each poll's outcome */
  onPollResult?: (outcome: PollOutcome) => void
  /**
   * How often to poll while nothing is failing: `active` (10–15s) while the user is using the tab or
   * changes just came from another device, `idle` (30s) while the tab is visible, and `hidden`
   * (5–10 min) while it isn't. Defaults to `idle`.
   */
  getCadence?: () => PollCadence
  /** When the next snapshot upload is due, which brings a poll forward if it's sooner */
  getSnapshotDueAt?: () => number | undefined
}

/**
 * Runs the session's sync: polls on the schedule `transitionPoll` decides. The
 * manifest sync is a phase of the poll, which this asks for (`ManifestSyncManager.request`). This
 * class owns the timers and runs the poll; every decision about when to poll is a transition of
 * `pollState` (see `pollSchedule.ts`).
 */
export class SyncOrchestrator {
  private pollState: PollState = INITIAL_POLL_STATE
  /** Identifies the poll whose result counts. Starting or aborting a poll makes earlier results stale. */
  private pollRunId = 0
  /** The latest poll, which settles after every earlier one */
  private pollInFlight: Promise<void> | null = null
  private readonly pollRun = new AbortableRun(() => this.isOperational)

  /** Armed while the schedule is `waiting` */
  private readonly pollTimer = new RetryTimer()
  /** Armed while a flush is queued, so flushes made in the same turn share one poll */
  private readonly flushTimer = new RetryTimer()

  constructor(private readonly deps: SyncOrchestratorDeps) {}

  get isOperational(): boolean {
    return this.deps.session.isOperational
  }

  /** Whether polling is paused until the user signs in again */
  get isAuthPaused(): boolean {
    return this.pollState.phase.kind === 'authPaused'
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
      manifestDueAt: this.deps.manifestSyncManager.getDueAt(),
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

  /** Starts syncing, once the session's components have loaded their state */
  start(): void {
    if (this.deps.session.isOnline) {
      this.startSyncing()
    } else {
      this.startPolling()
    }
  }

  /** Polls now, with a manifest sync unless a clean one ran within `manifestSyncMinGap` */
  private startSyncing(options?: { resetBackoff?: boolean }): void {
    this.deps.manifestSyncManager.request('due')
    this.startPolling(options)
  }

  /** Cancels scheduled and in-flight polls, and with them any manifest sync */
  private stopSyncing(): void {
    this.dispatch({ type: 'stop' })
  }

  /** Polls now, or right after the poll in flight */
  private startPolling(options?: { resetBackoff?: boolean }): void {
    if (this.isShutdown) return
    this.dispatch({ type: 'start', resetBackoff: options?.resetBackoff })
  }

  /** Stops syncing when the device goes offline, and resumes when it's back. The session holds the state. */
  onOnlineStateChange(): void {
    if (!this.deps.session.isOnline) {
      this.stopSyncing()
      return
    }

    this.startSyncing({ resetBackoff: true })
  }

  /**
   * Polls now when the user comes back to the tab, unless a poll is running or one
   * finished in the last `foregroundPollMinGap`. Backoff after failures resets too: the connection
   * may be back without an `online` event (captive portal, flaky network, a phone waking). Also asks
   * for a manifest sync, which skips itself if one finished in the last `manifestSyncMinGap`; if no
   * poll runs now, the next one runs it.
   */
  onForeground(): void {
    if (!this.isOperational) return
    this.deps.manifestSyncManager.request('due')
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
    if (this.isShutdown) return
    while (this.pollInFlight) {
      await this.pollInFlight
    }
    this.dispatch({ type: 'pollNow' })
    await this.pollInFlight
  }

  /**
   * Runs a poll whose manifest phase syncs at `mode` or stronger, after the poll in flight, and
   * returns that sync's result. A poll that fails before its manifest phase, or one that doesn't run
   * (offline, shut down), returns a failure without leaving the sync asked for.
   */
  async syncManifest(mode: ManifestMode): Promise<ManifestPhaseResult> {
    const { manifestSyncManager } = this.deps
    while (this.pollInFlight) {
      await this.pollInFlight
    }
    const ticket = manifestSyncManager.openTicket(mode)
    try {
      await this.pollNow()
    } catch (error) {
      manifestSyncManager.closeTicket(ticket)
      throw error
    }
    return manifestSyncManager.closeTicket(ticket)
  }

  /** Polls soon to push local changes, batching flushes made in the same turn into one poll */
  flush(): void {
    if (this.isShutdown) return
    this.dispatch({ type: 'flush' })
  }

  /** Stops polling. The context has already marked the session shut down. */
  async shutdown(): Promise<void> {
    this.stopSyncing()
    await this.pollInFlight
  }
}
