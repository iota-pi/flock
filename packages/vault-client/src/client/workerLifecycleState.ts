import { DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

/**
 * Where the main thread's sync worker stands, as one state value and a pure transition function.
 * `WorkerLifecycleManager` owns the worker, the run that starts it, the timer and the shutdown
 * sequence, and carries out the effects each transition returns.
 */

export type LifecyclePhase =
  /** No account is syncing: nothing has started, a shutdown finished, or starting gave up */
  | { kind: 'idle' }
  /** Run `run` is starting a worker for the account. `clearLocalData` clears the account's local data first. */
  | { kind: 'starting'; accountId: string; run: number; clearLocalData: boolean }
  /** A start failed, and the timer starts the next attempt */
  | { kind: 'retryWaiting'; accountId: string; clearLocalData: boolean }
  | { kind: 'ready'; accountId: string }
  /** The worker crashed, and the timer starts a new one */
  | { kind: 'restarting'; accountId: string }
  /** The worker crashed too often to restart. Only an `initialize` starts sync again. */
  | { kind: 'halted'; accountId: string }
  /** A shutdown is closing the worker. An `initialize` may take over, and waits for it to finish. */
  | { kind: 'shuttingDown' }
  /**
   * Another tab took over the account, so this tab's worker has closed, leaving what the app shows in
   * place. Only an `initialize` (taking over again) starts sync again.
   */
  | { kind: 'displaced'; accountId: string }

export interface LifecycleState {
  phase: LifecyclePhase
  /** Failed starts in a row, which picks the retry delay. Only a success or a new `initialize` resets it. */
  initFailures: number
  /** The latest run's number, so a run can tell that a newer one or a shutdown superseded it */
  lastRun: number
}

export type LifecycleEvent =
  | { type: 'initialize'; accountId: string; clearLocalData: boolean }
  | { type: 'runSucceeded'; run: number }
  | { type: 'runFailed'; run: number }
  /** The retry or restart timer fired */
  | { type: 'timerFired' }
  /** The ready worker crashed. `willRestart` is false once it has crashed too often. */
  | { type: 'crashed'; willRestart: boolean }
  | { type: 'shutdown' }
  /** A shutdown closed the worker, before it clears any local data */
  | { type: 'shutdownFinished' }
  /** Another tab took over the account: the ready worker's session stopped, or a run couldn't take the lock */
  | { type: 'displaced' }

export type LifecycleEffect =
  | { type: 'startRun'; run: number; accountId: string; clearLocalData: boolean }
  /** Abort the run in flight, which a newer run or a shutdown superseded */
  | { type: 'abortRun' }
  | { type: 'armTimer'; delayMs: number }
  | { type: 'cancelTimer' }
  /** The run's worker is ready: report it and watch its health */
  | { type: 'ready' }
  | { type: 'reportRetry'; delayMs: number }
  /** Starting failed too often, so sync is offline until something initializes again */
  | { type: 'reportFatal' }
  | { type: 'reportOffline' }
  /** Close the worker without resetting what the app shows, then tell the app it was displaced */
  | { type: 'closeDisplaced'; accountId: string }

export interface LifecycleTransition {
  state: LifecycleState
  effects: LifecycleEffect[]
}

/** Failed starts retried before giving up, each after the next of `INIT_RETRY_DELAYS` */
export const MAX_INIT_RETRIES = 5
export const INIT_RETRY_DELAYS: readonly number[] = DEFAULT_RETRY_DELAYS

export const INITIAL_LIFECYCLE_STATE: LifecycleState = {
  phase: { kind: 'idle' },
  initFailures: 0,
  lastRun: 0,
}

/** The account the phase is syncing, or about to */
export function phaseAccountId(phase: LifecyclePhase): string | null {
  return 'accountId' in phase ? phase.accountId : null
}

/** Whether a worker is on its way, so `ensureReady` waits rather than failing */
export function isPending(phase: LifecyclePhase): boolean {
  return phase.kind === 'starting' || phase.kind === 'retryWaiting' || phase.kind === 'restarting'
}

/** Whether `run` is still the run starting the worker */
export function isCurrentRun(state: LifecycleState, run: number): boolean {
  return state.phase.kind === 'starting' && state.phase.run === run
}

export function initRetryDelay(initFailures: number): number {
  return INIT_RETRY_DELAYS[Math.min(initFailures, INIT_RETRY_DELAYS.length - 1)]
}

function unchanged(state: LifecycleState): LifecycleTransition {
  return { state, effects: [] }
}

/** Stops what the phase has in flight: its run or its timer */
function leave(phase: LifecyclePhase): LifecycleEffect[] {
  switch (phase.kind) {
    case 'starting':
      return [{ type: 'abortRun' }]
    case 'retryWaiting':
    case 'restarting':
      return [{ type: 'cancelTimer' }]
    default:
      return []
  }
}

function startRun(
  state: LifecycleState,
  accountId: string,
  clearLocalData: boolean,
  effects: LifecycleEffect[],
): LifecycleTransition {
  const run = state.lastRun + 1
  return {
    state: { ...state, phase: { kind: 'starting', accountId, run, clearLocalData }, lastRun: run },
    effects: [...effects, { type: 'startRun', run, accountId, clearLocalData }],
  }
}

/** Whether the phase is running, or bringing up, a worker for the account */
function isActiveFor(phase: LifecyclePhase, accountId: string): boolean {
  return (isPending(phase) || phase.kind === 'ready') && phaseAccountId(phase) === accountId
}

/** The next state, and what the manager must do. Returns `state` itself when nothing changes. */
export function transitionLifecycle(state: LifecycleState, event: LifecycleEvent): LifecycleTransition {
  const { phase } = state
  switch (event.type) {
    case 'initialize':
      // A worker for the account that is running or on its way serves this, unless it must clear first
      if (!event.clearLocalData && isActiveFor(phase, event.accountId)) return unchanged(state)
      return startRun({ ...state, initFailures: 0 }, event.accountId, event.clearLocalData, leave(phase))

    case 'runSucceeded':
      if (!isCurrentRun(state, event.run) || phase.kind !== 'starting') return unchanged(state)
      return {
        state: { ...state, phase: { kind: 'ready', accountId: phase.accountId }, initFailures: 0 },
        effects: [{ type: 'ready' }],
      }

    case 'runFailed': {
      if (!isCurrentRun(state, event.run) || phase.kind !== 'starting') return unchanged(state)
      if (state.initFailures >= MAX_INIT_RETRIES) {
        return {
          state: { ...state, phase: { kind: 'idle' }, initFailures: 0 },
          effects: [{ type: 'reportFatal' }],
        }
      }
      const delayMs = initRetryDelay(state.initFailures)
      return {
        state: {
          ...state,
          phase: { kind: 'retryWaiting', accountId: phase.accountId, clearLocalData: phase.clearLocalData },
          initFailures: state.initFailures + 1,
        },
        effects: [{ type: 'armTimer', delayMs }, { type: 'reportRetry', delayMs }],
      }
    }

    case 'timerFired':
      if (phase.kind === 'retryWaiting') return startRun(state, phase.accountId, phase.clearLocalData, [])
      if (phase.kind === 'restarting') return startRun(state, phase.accountId, false, [])
      return unchanged(state)

    case 'crashed':
      if (phase.kind !== 'ready') return unchanged(state)
      if (!event.willRestart) {
        return { state: { ...state, phase: { kind: 'halted', accountId: phase.accountId } }, effects: [] }
      }
      return {
        state: { ...state, phase: { kind: 'restarting', accountId: phase.accountId } },
        effects: [{ type: 'armTimer', delayMs: SYNC_TIMEOUTS.workerRestartDelay }],
      }

    case 'shutdown':
      if (phase.kind === 'shuttingDown') return unchanged(state)
      return { state: { ...state, phase: { kind: 'shuttingDown' }, initFailures: 0 }, effects: leave(phase) }

    case 'shutdownFinished':
      // An initialize during the shutdown took over, and reports its own status
      if (phase.kind !== 'shuttingDown') return unchanged(state)
      return { state: { ...state, phase: { kind: 'idle' } }, effects: [{ type: 'reportOffline' }] }

    case 'displaced':
      if (phase.kind !== 'ready' && phase.kind !== 'starting') return unchanged(state)
      return {
        state: { ...state, phase: { kind: 'displaced', accountId: phase.accountId }, initFailures: 0 },
        effects: [...leave(phase), { type: 'closeDisplaced', accountId: phase.accountId }],
      }
  }
}
