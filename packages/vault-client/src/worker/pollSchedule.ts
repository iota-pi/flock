import { RetryStrategy, DEFAULT_POLL_BACKOFF_DELAYS } from '../utils/RetryStrategy'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { PollOutcome } from './SyncPoller'

/**
 * When the leader polls, as one state value and a pure transition function. `SyncOrchestrator` owns
 * the timers and the poll itself: it arms the poll timer for `waiting.until`, the flush timer while
 * `flushQueued`, and carries out the effects each transition returns.
 */

export type PollCadence = 'active' | 'idle' | 'hidden'

/** Why the next poll is due when it is */
export type WaitReason =
  /** The interval for the current cadence */
  | 'cadence'
  /** Failure backoff */
  | 'backoff'
  /** A flush arrived during the last poll */
  | 'rerun'
  /** The pull queue has more pages */
  | 'morePages'
  /** A gap in the log may have filled by then */
  | 'gap'
  /** Snapshot uploads are due */
  | 'snapshot'
  /** The user became active, which brought an idle poll forward */
  | 'activity'

export type PollPhase =
  /**
   * No poll in flight or scheduled: the tab can't poll (a follower, offline or shut down), or an
   * auth pause was just lifted by a flush. `flushPending` records a flush to honour once it polls.
   */
  | { kind: 'idle'; flushPending: boolean }
  | { kind: 'waiting'; until: number; reason: WaitReason }
  /** `rerun` polls again at once when this poll finishes, unless it failed */
  | { kind: 'polling'; rerun: boolean }
  /** The session expired. Only a flush, `pollNow` or a restart polls again. */
  | { kind: 'authPaused'; flushPending: boolean }

export interface PollState {
  phase: PollPhase
  /**
   * Failed polls in a row, which picks the backoff delay, clamped at the last one. It outlives the
   * wait: a forced poll while backing off keeps it, and only a success or a fresh start resets it.
   */
  attempt: number
  /** When the last poll with a result finished, for `foregroundPollMinGap` */
  lastPollFinishedAt: number
  /** A flush is waiting for the 0ms timer that batches flushes made in the same turn */
  flushQueued: boolean
}

/** What a poll came to. `aborted` is an abort the orchestrator didn't ask for. */
export type PollResult = PollOutcome | 'aborted'

export type PollEvent =
  /** This tab can poll now: it became the leader, or came back online (`resetBackoff`) */
  | { type: 'start'; resetBackoff?: boolean }
  /** This tab can no longer poll: it stopped leading, went offline or is shutting down */
  | { type: 'stop' }
  /** The user came back to one of the account's tabs */
  | { type: 'foreground' }
  /** The user is active in one of the account's tabs */
  | { type: 'activity' }
  /** When snapshots are due changed */
  | { type: 'snapshotDue' }
  /** Local changes want pushing */
  | { type: 'flush' }
  /** The flush batch timer fired */
  | { type: 'flushBatch' }
  /** The poll timer fired */
  | { type: 'timerFired' }
  /** Poll now, even while backing off or paused for auth */
  | { type: 'pollNow' }
  | { type: 'pollFinished'; result: PollResult; hasImmediatePendingPulls: boolean; gapRepollDelay: number | undefined }

export type PollEffect =
  | { type: 'startPoll' }
  | { type: 'abortPoll' }
  /** Tell the app the session expired */
  | { type: 'reportAuthFailure' }
  /** Report the outcome once the next poll is scheduled, so a failing receiver can't stop polling */
  | { type: 'reportResult'; outcome: PollOutcome }

/** What a transition reads besides the state */
export interface PollContext {
  now: number
  /** The session is running, online and leading */
  isOperational: boolean
  cadence: PollCadence
  snapshotDueAt: number | undefined
  /** Returns [0, 1), for jitter and for picking intervals from a range */
  random: () => number
}

export interface PollTransition {
  state: PollState
  effects: PollEffect[]
}

export const POLL_BACKOFF_DELAYS: readonly number[] = DEFAULT_POLL_BACKOFF_DELAYS
const POLL_JITTER = { factor: 0.25, maxJitterMs: 15000 }

export const INITIAL_POLL_STATE: PollState = {
  phase: { kind: 'idle', flushPending: false },
  attempt: 0,
  lastPollFinishedAt: 0,
  flushQueued: false,
}

export function backoffDelay(attempt: number): number {
  return POLL_BACKOFF_DELAYS[Math.min(attempt, POLL_BACKOFF_DELAYS.length - 1)]
}

/** A whole number of milliseconds picked uniformly from `min` to `max` */
function randomBetween(min: number, max: number, random: () => number): number {
  return Math.floor(min + random() * (max - min + 1))
}

function jitter(delayMs: number, ctx: PollContext): number {
  return RetryStrategy.applyJitter(delayMs, { ...POLL_JITTER, randomFn: ctx.random })
}

function snapshotDueDelay(ctx: PollContext): number | undefined {
  return ctx.snapshotDueAt === undefined ? undefined : Math.max(0, ctx.snapshotDueAt - ctx.now)
}

/** A flush to honour once polling starts, from the phase before it */
function carriedFlush(state: PollState): boolean {
  const { phase } = state
  const pending = phase.kind === 'idle' || phase.kind === 'authPaused' ? phase.flushPending
    : phase.kind === 'polling' ? phase.rerun
      : false
  return pending || state.flushQueued
}

function unchanged(state: PollState): PollTransition {
  return { state, effects: [] }
}

function waitFor(state: PollState, ctx: PollContext, delayMs: number, reason: WaitReason): PollTransition {
  return { state: { ...state, phase: { kind: 'waiting', until: ctx.now + delayMs, reason } }, effects: [] }
}

/** Polls now, or right after the poll in flight. Drops a queued flush, which this poll serves. */
function startPolling(state: PollState, ctx: PollContext): PollTransition {
  const rerun = carriedFlush(state)
  if (!ctx.isOperational) {
    return { state: { ...state, phase: { kind: 'idle', flushPending: rerun }, flushQueued: false }, effects: [] }
  }
  if (state.phase.kind === 'polling') {
    return { state: { ...state, phase: { kind: 'polling', rerun: true }, flushQueued: false }, effects: [] }
  }
  return {
    state: { ...state, phase: { kind: 'polling', rerun }, flushQueued: false },
    effects: [{ type: 'startPoll' }],
  }
}

/** Starts a poll without touching the flush batch, keeping a flush that was waiting to poll */
function pollNow(state: PollState, ctx: PollContext): PollTransition {
  const { phase } = state
  if (!ctx.isOperational || phase.kind === 'polling') return unchanged(state)
  const rerun = phase.kind === 'idle' || phase.kind === 'authPaused' ? phase.flushPending : false
  return { state: { ...state, phase: { kind: 'polling', rerun } }, effects: [{ type: 'startPoll' }] }
}

/** Lifts an auth pause, leaving nothing scheduled until something polls */
function liftAuthPause(state: PollState): PollState {
  return state.phase.kind === 'authPaused'
    ? { ...state, phase: { kind: 'idle', flushPending: state.phase.flushPending } }
    : state
}

type Waiting = Extract<PollPhase, { kind: 'waiting' }>

/** The scheduled poll, if a nudge (activity, snapshots due) may move it: never failure backoff */
function movableWait(state: PollState, ctx: PollContext): Waiting | undefined {
  return ctx.isOperational && state.attempt === 0 && state.phase.kind === 'waiting' ? state.phase : undefined
}

function onPollFinished(
  state: PollState,
  event: Extract<PollEvent, { type: 'pollFinished' }>,
  ctx: PollContext,
): PollTransition {
  if (state.phase.kind !== 'polling') return unchanged(state)
  const { rerun } = state.phase
  const { result } = event

  if (result === 'aborted') {
    return { state: { ...state, phase: { kind: 'idle', flushPending: rerun } }, effects: [] }
  }

  if (result === 'auth-failure') {
    return {
      state: { ...state, phase: { kind: 'authPaused', flushPending: rerun || state.flushQueued }, flushQueued: false },
      effects: [{ type: 'reportAuthFailure' }, { type: 'reportResult', outcome: 'auth-failure' }],
    }
  }

  const attempt = result === 'failure' ? Math.min(state.attempt + 1, POLL_BACKOFF_DELAYS.length - 1)
    : result === 'success' ? 0
      : state.attempt
  const next: PollState = { ...state, attempt, lastPollFinishedAt: ctx.now }
  const effects: PollEffect[] = [{ type: 'reportResult', outcome: result }]
  const wait = (delayMs: number, reason: WaitReason) => ({ ...waitFor(next, ctx, delayMs, reason), effects })

  // Rule 4: a failure waits out its backoff, even with a flush pending or more pages to pull
  if (result !== 'failure') {
    if (rerun) return wait(0, 'rerun')
    if (result === 'success' && event.hasImmediatePendingPulls) return wait(0, 'morePages')
  }

  // A gap never counts as immediate: it waits its own delay, when that's sooner than the cadence
  const gapDelay = result === 'success' ? event.gapRepollDelay : undefined
  // Snapshots wait out failure backoff with everything else
  const snapshotDelay = result === 'failure' ? undefined : snapshotDueDelay(ctx)
  const regular = regularDelay(attempt, ctx)
  if (gapDelay !== undefined && gapDelay < regular.delayMs && (snapshotDelay === undefined || gapDelay <= snapshotDelay)) {
    return wait(jitter(gapDelay, ctx), 'gap')
  }
  if (snapshotDelay !== undefined && snapshotDelay < regular.delayMs) {
    return wait(snapshotDelay, 'snapshot')
  }
  return wait(regular.isSpread ? regular.delayMs : jitter(regular.delayMs, ctx), attempt > 0 ? 'backoff' : 'cadence')
}

interface RegularDelay {
  delayMs: number
  /** Whether the delay was picked from a range, which spreads polls out already, so no jitter is added */
  isSpread: boolean
}

/** The backoff delay after failures, otherwise the interval for the current cadence */
function regularDelay(attempt: number, ctx: PollContext): RegularDelay {
  if (attempt > 0) {
    return { delayMs: backoffDelay(attempt), isSpread: false }
  }
  switch (ctx.cadence) {
    case 'active':
      return { delayMs: randomBetween(SYNC_TIMEOUTS.activePollMin, SYNC_TIMEOUTS.activePollMax, ctx.random), isSpread: true }
    case 'hidden':
      return { delayMs: randomBetween(SYNC_TIMEOUTS.hiddenPollMin, SYNC_TIMEOUTS.hiddenPollMax, ctx.random), isSpread: true }
    case 'idle':
      return { delayMs: backoffDelay(0), isSpread: false }
  }
}

/** The next state, and what the orchestrator must do. Returns `state` itself when nothing changes. */
export function transitionPoll(state: PollState, event: PollEvent, ctx: PollContext): PollTransition {
  switch (event.type) {
    case 'start':
      return startPolling(event.resetBackoff ? { ...state, attempt: 0 } : state, ctx)

    case 'stop': {
      const flushPending = carriedFlush(state)
      return {
        state: { ...state, phase: { kind: 'idle', flushPending }, flushQueued: false },
        effects: state.phase.kind === 'polling' ? [{ type: 'abortPoll' }] : [],
      }
    }

    case 'foreground': {
      // Resets backoff too: the connection may be back without an `online` event
      if (!ctx.isOperational || state.phase.kind === 'authPaused' || state.phase.kind === 'polling') return unchanged(state)
      const isBackingOff = state.attempt > 0
      if (!isBackingOff && ctx.now - state.lastPollFinishedAt < SYNC_TIMEOUTS.foregroundPollMinGap) return unchanged(state)
      return startPolling({ ...state, attempt: 0 }, ctx)
    }

    case 'activity': {
      // Never polls at once, and leaves failure backoff alone
      const wait = movableWait(state, ctx)
      if (!wait || ctx.cadence !== 'active') return unchanged(state)
      if (wait.until - ctx.now <= SYNC_TIMEOUTS.activePollMax) return unchanged(state)
      return waitFor(state, ctx, randomBetween(SYNC_TIMEOUTS.activePollMin, SYNC_TIMEOUTS.activePollMax, ctx.random), 'activity')
    }

    case 'snapshotDue': {
      const wait = movableWait(state, ctx)
      const dueDelay = snapshotDueDelay(ctx)
      if (!wait || dueDelay === undefined || ctx.now + dueDelay >= wait.until) return unchanged(state)
      return waitFor(state, ctx, dueDelay, 'snapshot')
    }

    case 'flush': {
      const lifted = liftAuthPause(state)
      return { state: lifted.flushQueued ? lifted : { ...lifted, flushQueued: true }, effects: [] }
    }

    case 'flushBatch': {
      const batched: PollState = { ...state, flushQueued: false }
      if (state.phase.kind === 'polling') {
        return { state: { ...batched, phase: { kind: 'polling', rerun: true } }, effects: [] }
      }
      if (state.attempt > 0) {
        // The flush waits out the backoff, without restarting it
        if (state.phase.kind === 'waiting' || !ctx.isOperational) return { state: batched, effects: [] }
        return waitFor(batched, ctx, jitter(backoffDelay(state.attempt), ctx), 'backoff')
      }
      return pollNow(batched, ctx)
    }

    case 'timerFired':
      if (state.phase.kind !== 'waiting' || !ctx.isOperational) return unchanged(state)
      return { state: { ...state, phase: { kind: 'polling', rerun: false } }, effects: [{ type: 'startPoll' }] }

    case 'pollNow':
      return pollNow(liftAuthPause(state), ctx)

    case 'pollFinished':
      return onPollFinished(state, event, ctx)
  }
}
