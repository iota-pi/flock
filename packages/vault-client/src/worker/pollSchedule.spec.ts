import {
  INITIAL_POLL_STATE,
  backoffDelay,
  transitionPoll,
  type PollContext,
  type PollEffect,
  type PollEvent,
  type PollPhase,
  type PollState,
} from './pollSchedule'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const NOW = 1_000_000

/** `random` is 0.5, which puts jitter at +0 (the window's middle) for even windows */
const ctx: PollContext = {
  now: NOW,
  isOperational: true,
  cadence: 'idle',
  snapshotDueAt: undefined,
  random: () => 0.5,
}

function state(phase: PollPhase, overrides: Partial<PollState> = {}): PollState {
  return { ...INITIAL_POLL_STATE, phase, ...overrides }
}

const idle = (flushPending = false): PollPhase => ({ kind: 'idle', flushPending })
const polling = (rerun = false): PollPhase => ({ kind: 'polling', rerun })
const authPaused = (flushPending = false): PollPhase => ({ kind: 'authPaused', flushPending })
const waiting = (inMs: number, reason: Extract<PollPhase, { kind: 'waiting' }>['reason'] = 'cadence'): PollPhase => (
  { kind: 'waiting', until: NOW + inMs, reason }
)

function finished(
  result: Extract<PollEvent, { type: 'pollFinished' }>['result'],
  options: { hasImmediatePendingPulls?: boolean; gapRepollDelay?: number } = {},
): PollEvent {
  return {
    type: 'pollFinished',
    result,
    hasImmediatePendingPulls: options.hasImmediatePendingPulls ?? false,
    gapRepollDelay: options.gapRepollDelay,
  }
}

const START_POLL: PollEffect = { type: 'startPoll' }
const reported = (outcome: Extract<PollEffect, { type: 'reportResult' }>['outcome']): PollEffect => (
  { type: 'reportResult', outcome }
)

interface Row {
  name: string
  from: PollState
  event: PollEvent
  ctx?: Partial<PollContext>
  phase: PollPhase
  attempt?: number
  flushQueued?: boolean
  effects?: PollEffect[]
}

/** Each row runs one transition and checks the phase, backoff attempt, flush batch and effects */
function runTable(rows: Row[]): void {
  it.each(rows.map(row => [row.name, row] as const))('%s', (_name, row) => {
    const { state: next, effects } = transitionPoll(row.from, row.event, { ...ctx, ...row.ctx })
    expect(next.phase).toEqual(row.phase)
    expect(next.attempt).toBe(row.attempt ?? row.from.attempt)
    expect(next.flushQueued).toBe(row.flushQueued ?? false)
    expect(effects).toEqual(row.effects ?? [])
  })
}

describe('transitionPoll', () => {
  describe('after a poll (rule 4)', () => {
    runTable([
      {
        name: 'rule 4: a failure never polls at 0ms, even with a flush pending',
        from: state(polling(true)),
        event: finished('failure'),
        phase: waiting(backoffDelay(1), 'backoff'),
        attempt: 1,
        effects: [reported('failure')],
      },
      {
        name: 'rule 4: a failure never polls at 0ms, even with more pages to pull',
        from: state(polling()),
        event: finished('failure', { hasImmediatePendingPulls: true }),
        phase: waiting(backoffDelay(1), 'backoff'),
        attempt: 1,
        effects: [reported('failure')],
      },
      {
        name: 'rule 4: a gap never counts as immediate, and waits its own delay',
        from: state(polling()),
        event: finished('success', { gapRepollDelay: 5000 }),
        phase: waiting(5000, 'gap'),
        effects: [reported('success')],
      },
      {
        name: 'a gap delay longer than the cadence waits for the cadence',
        from: state(polling()),
        event: finished('success', { gapRepollDelay: 60_000 }),
        phase: waiting(30_000),
        effects: [reported('success')],
      },
      {
        name: 'a gap delay is ignored after a failure',
        from: state(polling()),
        event: finished('failure', { gapRepollDelay: 5000 }),
        phase: waiting(backoffDelay(1), 'backoff'),
        attempt: 1,
        effects: [reported('failure')],
      },
      {
        name: 'a success with a flush pending polls again at once',
        from: state(polling(true)),
        event: finished('success'),
        phase: waiting(0, 'rerun'),
        effects: [reported('success')],
      },
      {
        name: 'a success with more pages to pull polls again at once',
        from: state(polling()),
        event: finished('success', { hasImmediatePendingPulls: true }),
        phase: waiting(0, 'morePages'),
        effects: [reported('success')],
      },
      {
        name: 'a success resets backoff and waits for the cadence',
        from: state(polling(), { attempt: 2 }),
        event: finished('success'),
        phase: waiting(30_000),
        attempt: 0,
        effects: [reported('success')],
      },
      {
        name: 'failures step through the backoff delays',
        from: state(polling(), { attempt: 1 }),
        event: finished('failure'),
        phase: waiting(backoffDelay(2), 'backoff'),
        attempt: 2,
        effects: [reported('failure')],
      },
      {
        name: 'backoff stays at its last delay',
        from: state(polling(), { attempt: 3 }),
        event: finished('failure'),
        phase: waiting(backoffDelay(3), 'backoff'),
        attempt: 3,
        effects: [reported('failure')],
      },
      {
        name: 'no poll keeps backoff as it was, and still honours a flush',
        from: state(polling(true), { attempt: 1 }),
        event: finished('no-poll'),
        phase: waiting(0, 'rerun'),
        attempt: 1,
        effects: [reported('no-poll')],
      },
      {
        name: 'an auth failure pauses, keeping the flush for when polling resumes',
        from: state(polling(true)),
        event: finished('auth-failure'),
        phase: authPaused(true),
        effects: [{ type: 'reportAuthFailure' }, reported('auth-failure')],
      },
      {
        name: 'an auth failure takes over a queued flush',
        from: state(polling(), { flushQueued: true }),
        event: finished('auth-failure'),
        phase: authPaused(true),
        effects: [{ type: 'reportAuthFailure' }, reported('auth-failure')],
      },
      {
        name: 'an abort nobody asked for leaves nothing scheduled, keeping the flush',
        from: state(polling(true)),
        event: finished('aborted'),
        phase: idle(true),
      },
      {
        name: 'snapshots due sooner than the cadence bring the poll forward, without jitter',
        from: state(polling()),
        event: finished('success'),
        ctx: { snapshotDueAt: NOW + 7001 },
        phase: waiting(7001, 'snapshot'),
        effects: [reported('success')],
      },
      {
        name: 'snapshots wait out failure backoff',
        from: state(polling()),
        event: finished('failure'),
        ctx: { snapshotDueAt: NOW + 1000 },
        phase: waiting(backoffDelay(1), 'backoff'),
        attempt: 1,
        effects: [reported('failure')],
      },
      {
        name: 'a gap no later than due snapshots wins',
        from: state(polling()),
        event: finished('success', { gapRepollDelay: 4000 }),
        ctx: { snapshotDueAt: NOW + 4000 },
        phase: waiting(4000, 'gap'),
        effects: [reported('success')],
      },
      {
        name: 'due snapshots sooner than a gap win',
        from: state(polling()),
        event: finished('success', { gapRepollDelay: 4000 }),
        ctx: { snapshotDueAt: NOW + 3000 },
        phase: waiting(3000, 'snapshot'),
        effects: [reported('success')],
      },
      {
        name: 'the active cadence picks from its range, without jitter',
        from: state(polling()),
        event: finished('success'),
        ctx: { cadence: 'active', random: () => 0 },
        phase: waiting(SYNC_TIMEOUTS.activePollMin),
        effects: [reported('success')],
      },
      {
        name: 'the hidden cadence picks from its range, without jitter',
        from: state(polling()),
        event: finished('success'),
        ctx: { cadence: 'hidden', random: () => 0 },
        phase: waiting(SYNC_TIMEOUTS.hiddenPollMin),
        effects: [reported('success')],
      },
      {
        name: 'the idle cadence is jittered',
        from: state(polling()),
        event: finished('success'),
        ctx: { random: () => 0 },
        phase: waiting(30_000 - 3750),
        effects: [reported('success')],
      },
      {
        name: 'a stale result while not polling is ignored',
        from: state(waiting(1000)),
        event: finished('success'),
        phase: waiting(1000),
      },
    ])

    it('records when the poll finished, for the foreground gap', () => {
      const { state: next } = transitionPoll(state(polling()), finished('failure'), ctx)
      expect(next.lastPollFinishedAt).toBe(NOW)
    })
  })

  describe('starting and stopping', () => {
    runTable([
      {
        name: 'starting polls at once',
        from: state(idle()),
        event: { type: 'start' },
        phase: polling(),
        effects: [START_POLL],
      },
      {
        name: 'starting keeps a flush from before the stop for after the poll',
        from: state(idle(true)),
        event: { type: 'start' },
        phase: polling(true),
        effects: [START_POLL],
      },
      {
        name: 'starting takes over a queued flush',
        from: state(waiting(1000), { flushQueued: true }),
        event: { type: 'start' },
        phase: polling(true),
        effects: [START_POLL],
      },
      {
        name: 'starting during a poll polls again once it finishes',
        from: state(polling()),
        event: { type: 'start' },
        phase: polling(true),
      },
      {
        name: 'starting lifts an auth pause',
        from: state(authPaused()),
        event: { type: 'start' },
        phase: polling(),
        effects: [START_POLL],
      },
      {
        name: 'starting keeps backoff, unless coming back online',
        from: state(idle(), { attempt: 2 }),
        event: { type: 'start' },
        phase: polling(),
        effects: [START_POLL],
      },
      {
        name: 'coming back online resets backoff',
        from: state(idle(), { attempt: 2 }),
        event: { type: 'start', resetBackoff: true },
        phase: polling(),
        attempt: 0,
        effects: [START_POLL],
      },
      {
        name: 'a leader that is offline does not poll, but keeps a queued flush',
        from: state(idle(), { flushQueued: true }),
        event: { type: 'start' },
        ctx: { isOperational: false },
        phase: idle(true),
      },
      {
        name: 'stopping aborts the poll in flight, keeping its flush',
        from: state(polling(true)),
        event: { type: 'stop' },
        phase: idle(true),
        effects: [{ type: 'abortPoll' }],
      },
      {
        name: 'stopping drops the scheduled poll and keeps a queued flush',
        from: state(waiting(1000), { flushQueued: true }),
        event: { type: 'stop' },
        phase: idle(true),
      },
    ])
  })

  describe('flushes', () => {
    runTable([
      {
        name: 'a flush is batched',
        from: state(waiting(30_000)),
        event: { type: 'flush' },
        phase: waiting(30_000),
        flushQueued: true,
      },
      {
        name: 'a flush lifts an auth pause',
        from: state(authPaused(true)),
        event: { type: 'flush' },
        phase: idle(true),
        flushQueued: true,
      },
      {
        name: 'the batch polls at once',
        from: state(waiting(30_000), { flushQueued: true }),
        event: { type: 'flushBatch' },
        phase: polling(),
        effects: [START_POLL],
      },
      {
        name: 'the batch polls with a flush kept from before',
        from: state(idle(true), { flushQueued: true }),
        event: { type: 'flushBatch' },
        phase: polling(true),
        effects: [START_POLL],
      },
      {
        name: 'the batch during a poll polls again once it finishes',
        from: state(polling(), { flushQueued: true }),
        event: { type: 'flushBatch' },
        phase: polling(true),
      },
      {
        name: 'the batch waits out backoff without restarting it',
        from: state(waiting(10_000, 'backoff'), { attempt: 1, flushQueued: true }),
        event: { type: 'flushBatch' },
        phase: waiting(10_000, 'backoff'),
      },
      {
        name: 'the batch schedules backoff when nothing is scheduled',
        from: state(idle(), { attempt: 1, flushQueued: true }),
        event: { type: 'flushBatch' },
        phase: waiting(backoffDelay(1), 'backoff'),
      },
      {
        name: 'the batch does nothing while the tab cannot poll',
        from: state(idle(), { flushQueued: true }),
        event: { type: 'flushBatch' },
        ctx: { isOperational: false },
        phase: idle(),
      },
    ])
  })

  describe('the poll timer and pollNow', () => {
    runTable([
      {
        name: 'the timer polls',
        from: state(waiting(0)),
        event: { type: 'timerFired' },
        phase: polling(),
        effects: [START_POLL],
      },
      {
        name: 'a stale timer while paused does nothing',
        from: state(authPaused()),
        event: { type: 'timerFired' },
        phase: authPaused(),
      },
      {
        name: 'pollNow polls while backing off',
        from: state(waiting(60_000, 'backoff'), { attempt: 2 }),
        event: { type: 'pollNow' },
        phase: polling(),
        effects: [START_POLL],
      },
      {
        name: 'pollNow polls while paused for auth',
        from: state(authPaused(true)),
        event: { type: 'pollNow' },
        phase: polling(true),
        effects: [START_POLL],
      },
      {
        name: 'pollNow leaves a queued flush to its batch',
        from: state(waiting(30_000), { flushQueued: true }),
        event: { type: 'pollNow' },
        phase: polling(),
        flushQueued: true,
        effects: [START_POLL],
      },
    ])
  })

  describe('foreground, activity and snapshots due', () => {
    const recentlyPolled = { lastPollFinishedAt: NOW - SYNC_TIMEOUTS.foregroundPollMinGap + 1 }
    const longAgo = { lastPollFinishedAt: NOW - SYNC_TIMEOUTS.foregroundPollMinGap }

    runTable([
      {
        name: 'foreground polls once the last poll is older than the minimum gap',
        from: state(waiting(20_000), longAgo),
        event: { type: 'foreground' },
        phase: polling(),
        effects: [START_POLL],
      },
      {
        name: 'foreground skips a poll that finished within the minimum gap',
        from: state(waiting(20_000), recentlyPolled),
        event: { type: 'foreground' },
        phase: waiting(20_000),
      },
      {
        name: 'foreground polls at once and resets backoff, however recent the last poll',
        from: state(waiting(60_000, 'backoff'), { ...recentlyPolled, attempt: 2 }),
        event: { type: 'foreground' },
        phase: polling(),
        attempt: 0,
        effects: [START_POLL],
      },
      {
        name: 'foreground leaves a poll in flight alone',
        from: state(polling(), longAgo),
        event: { type: 'foreground' },
        phase: polling(),
      },
      {
        name: 'foreground does not lift an auth pause',
        from: state(authPaused(), longAgo),
        event: { type: 'foreground' },
        phase: authPaused(),
      },
      {
        name: 'activity brings an idle poll forward to the active rate',
        from: state(waiting(30_000)),
        event: { type: 'activity' },
        ctx: { cadence: 'active', random: () => 0 },
        phase: waiting(SYNC_TIMEOUTS.activePollMin, 'activity'),
      },
      {
        name: 'activity leaves a poll already due within the active rate',
        from: state(waiting(SYNC_TIMEOUTS.activePollMax)),
        event: { type: 'activity' },
        ctx: { cadence: 'active' },
        phase: waiting(SYNC_TIMEOUTS.activePollMax),
      },
      {
        name: 'activity leaves failure backoff alone',
        from: state(waiting(60_000, 'backoff'), { attempt: 1 }),
        event: { type: 'activity' },
        ctx: { cadence: 'active' },
        phase: waiting(60_000, 'backoff'),
      },
      {
        name: 'activity while no tab is visible changes nothing',
        from: state(waiting(300_000)),
        event: { type: 'activity' },
        ctx: { cadence: 'hidden' },
        phase: waiting(300_000),
      },
      {
        name: 'activity on a tab that cannot poll changes nothing',
        from: state(waiting(30_000)),
        event: { type: 'activity' },
        ctx: { cadence: 'active', isOperational: false },
        phase: waiting(30_000),
      },
      {
        name: 'due snapshots bring a later poll forward',
        from: state(waiting(300_000)),
        event: { type: 'snapshotDue' },
        ctx: { snapshotDueAt: NOW + 5000 },
        phase: waiting(5000, 'snapshot'),
      },
      {
        name: 'snapshots already overdue poll at once',
        from: state(waiting(300_000)),
        event: { type: 'snapshotDue' },
        ctx: { snapshotDueAt: NOW - 5000 },
        phase: waiting(0, 'snapshot'),
      },
      {
        name: 'due snapshots leave a sooner poll alone',
        from: state(waiting(3000)),
        event: { type: 'snapshotDue' },
        ctx: { snapshotDueAt: NOW + 5000 },
        phase: waiting(3000),
      },
      {
        name: 'due snapshots leave failure backoff alone',
        from: state(waiting(60_000, 'backoff'), { attempt: 1 }),
        event: { type: 'snapshotDue' },
        ctx: { snapshotDueAt: NOW + 5000 },
        phase: waiting(60_000, 'backoff'),
      },
      {
        name: 'due snapshots do not lift an auth pause',
        from: state(authPaused()),
        event: { type: 'snapshotDue' },
        ctx: { snapshotDueAt: NOW },
        phase: authPaused(),
      },
    ])
  })

  it('returns the same state when nothing changes', () => {
    const from = state(authPaused())
    expect(transitionPoll(from, { type: 'activity' }, ctx).state).toBe(from)
  })
})
