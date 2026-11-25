import {
  INITIAL_LIFECYCLE_STATE,
  INIT_RETRY_DELAYS,
  MAX_INIT_RETRIES,
  initRetryDelay,
  isPending,
  phaseAccountId,
  transitionLifecycle,
  type LifecycleEffect,
  type LifecycleEvent,
  type LifecyclePhase,
  type LifecycleState,
} from './workerLifecycleState'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const LAST_RUN = 4

function state(phase: LifecyclePhase, overrides: Partial<LifecycleState> = {}): LifecycleState {
  return { ...INITIAL_LIFECYCLE_STATE, phase, lastRun: LAST_RUN, ...overrides }
}

const idle: LifecyclePhase = { kind: 'idle' }
const shuttingDown: LifecyclePhase = { kind: 'shuttingDown' }
const starting = (accountId = 'a', run = LAST_RUN, clearLocalData = false): LifecyclePhase => (
  { kind: 'starting', accountId, run, clearLocalData }
)
const retryWaiting = (accountId = 'a', clearLocalData = false): LifecyclePhase => (
  { kind: 'retryWaiting', accountId, clearLocalData }
)
const ready = (accountId = 'a'): LifecyclePhase => ({ kind: 'ready', accountId })
const restarting = (accountId = 'a'): LifecyclePhase => ({ kind: 'restarting', accountId })
const halted = (accountId = 'a'): LifecyclePhase => ({ kind: 'halted', accountId })

const init = (accountId = 'a', clearLocalData = false): LifecycleEvent => ({ type: 'initialize', accountId, clearLocalData })
const NEXT_RUN = LAST_RUN + 1
const startRun = (accountId = 'a', clearLocalData = false): LifecycleEffect => (
  { type: 'startRun', run: NEXT_RUN, accountId, clearLocalData }
)
const ABORT_RUN: LifecycleEffect = { type: 'abortRun' }
const CANCEL_TIMER: LifecycleEffect = { type: 'cancelTimer' }

interface Row {
  name: string
  from: LifecycleState
  event: LifecycleEvent
  phase: LifecyclePhase
  initFailures?: number
  effects?: LifecycleEffect[]
}

/** Each row runs one transition and checks the phase, failure count and effects */
function runTable(rows: Row[]): void {
  it.each(rows.map(row => [row.name, row] as const))('%s', (_name, row) => {
    const { state: next, effects } = transitionLifecycle(row.from, row.event)
    expect(next.phase).toEqual(row.phase)
    expect(next.initFailures).toBe(row.initFailures ?? row.from.initFailures)
    expect(effects).toEqual(row.effects ?? [])
    // Only starting a run takes a new run number
    const startsRun = effects.some(effect => effect.type === 'startRun')
    expect(next.lastRun).toBe(startsRun ? NEXT_RUN : row.from.lastRun)
  })
}

describe('transitionLifecycle', () => {
  describe('initialize', () => {
    runTable([
      {
        name: 'starts a run from idle',
        from: state(idle),
        event: init(),
        phase: starting('a', NEXT_RUN),
        effects: [startRun()],
      },
      {
        name: 'joins a ready worker for the same account',
        from: state(ready()),
        event: init(),
        phase: ready(),
      },
      {
        name: 'joins a run for the same account',
        from: state(starting()),
        event: init(),
        phase: starting(),
      },
      {
        name: 'joins a retry for the same account, keeping its failure count',
        from: state(retryWaiting(), { initFailures: 2 }),
        event: init(),
        phase: retryWaiting(),
      },
      {
        name: 'joins a restart for the same account',
        from: state(restarting()),
        event: init(),
        phase: restarting(),
      },
      {
        name: 'restarts a halted worker',
        from: state(halted()),
        event: init(),
        phase: starting('a', NEXT_RUN),
        effects: [startRun()],
      },
      {
        name: 'replaces a ready worker to clear local data',
        from: state(ready()),
        event: init('a', true),
        phase: starting('a', NEXT_RUN, true),
        effects: [startRun('a', true)],
      },
      {
        name: 'aborts a run for another account',
        from: state(starting('a')),
        event: init('b'),
        phase: starting('b', NEXT_RUN),
        effects: [ABORT_RUN, startRun('b')],
      },
      {
        name: 'cancels a pending retry for another account and resets the failure count',
        from: state(retryWaiting('a'), { initFailures: 3 }),
        event: init('b'),
        phase: starting('b', NEXT_RUN),
        initFailures: 0,
        effects: [CANCEL_TIMER, startRun('b')],
      },
      {
        name: 'cancels a pending restart for another account',
        from: state(restarting('a')),
        event: init('b'),
        phase: starting('b', NEXT_RUN),
        effects: [CANCEL_TIMER, startRun('b')],
      },
      {
        name: 'takes over from a shutdown, whose close the run waits for',
        from: state(shuttingDown),
        event: init(),
        phase: starting('a', NEXT_RUN),
        effects: [startRun()],
      },
    ])
  })

  describe('a run finishing', () => {
    runTable([
      {
        name: 'a success makes the worker ready and resets the failure count',
        from: state(starting(), { initFailures: 3 }),
        event: { type: 'runSucceeded', run: LAST_RUN },
        phase: ready(),
        initFailures: 0,
        effects: [{ type: 'ready' }],
      },
      {
        name: 'a superseded run succeeding changes nothing',
        from: state(starting()),
        event: { type: 'runSucceeded', run: LAST_RUN - 1 },
        phase: starting(),
      },
      {
        name: 'a run succeeding after a shutdown changes nothing',
        from: state(shuttingDown),
        event: { type: 'runSucceeded', run: LAST_RUN },
        phase: shuttingDown,
      },
      {
        name: 'the first failure retries after the first delay',
        from: state(starting('a', LAST_RUN, true)),
        event: { type: 'runFailed', run: LAST_RUN },
        phase: retryWaiting('a', true),
        initFailures: 1,
        effects: [{ type: 'armTimer', delayMs: INIT_RETRY_DELAYS[0] }, { type: 'reportRetry', delayMs: INIT_RETRY_DELAYS[0] }],
      },
      {
        name: 'later failures back off further',
        from: state(starting(), { initFailures: 2 }),
        event: { type: 'runFailed', run: LAST_RUN },
        phase: retryWaiting(),
        initFailures: 3,
        effects: [{ type: 'armTimer', delayMs: INIT_RETRY_DELAYS[2] }, { type: 'reportRetry', delayMs: INIT_RETRY_DELAYS[2] }],
      },
      {
        name: 'gives up once the retries run out, and drops the account',
        from: state(starting(), { initFailures: MAX_INIT_RETRIES }),
        event: { type: 'runFailed', run: LAST_RUN },
        phase: idle,
        initFailures: 0,
        effects: [{ type: 'reportFatal' }],
      },
      {
        name: 'a superseded run failing changes nothing',
        from: state(starting('b')),
        event: { type: 'runFailed', run: LAST_RUN - 1 },
        phase: starting('b'),
      },
    ])
  })

  describe('the timer', () => {
    runTable([
      {
        name: 'a retry starts a new run for the same account, keeping the failure count and clearLocalData',
        from: state(retryWaiting('a', true), { initFailures: 2 }),
        event: { type: 'timerFired' },
        phase: starting('a', NEXT_RUN, true),
        effects: [startRun('a', true)],
      },
      {
        name: 'a restart starts a new run for the crashed account',
        from: state(restarting()),
        event: { type: 'timerFired' },
        phase: starting('a', NEXT_RUN),
        effects: [startRun()],
      },
      {
        name: 'a stale timer changes nothing',
        from: state(ready()),
        event: { type: 'timerFired' },
        phase: ready(),
      },
      {
        name: 'a timer firing after a shutdown changes nothing',
        from: state(shuttingDown),
        event: { type: 'timerFired' },
        phase: shuttingDown,
      },
    ])
  })

  describe('crashes', () => {
    runTable([
      {
        name: 'a ready worker crashing restarts after a delay',
        from: state(ready()),
        event: { type: 'crashed', willRestart: true },
        phase: restarting(),
        effects: [{ type: 'armTimer', delayMs: SYNC_TIMEOUTS.workerRestartDelay }],
      },
      {
        name: 'a worker that crashed too often halts, keeping its account',
        from: state(ready()),
        event: { type: 'crashed', willRestart: false },
        phase: halted(),
      },
      {
        name: 'a crash reported outside ready changes nothing',
        from: state(starting()),
        event: { type: 'crashed', willRestart: true },
        phase: starting(),
      },
    ])
  })

  describe('shutdown', () => {
    runTable([
      {
        name: 'from idle, still reports offline once closed',
        from: state(idle),
        event: { type: 'shutdown' },
        phase: shuttingDown,
      },
      {
        name: 'aborts a run',
        from: state(starting()),
        event: { type: 'shutdown' },
        phase: shuttingDown,
        effects: [ABORT_RUN],
      },
      {
        name: 'cancels a retry and resets the failure count',
        from: state(retryWaiting(), { initFailures: 3 }),
        event: { type: 'shutdown' },
        phase: shuttingDown,
        initFailures: 0,
        effects: [CANCEL_TIMER],
      },
      {
        name: 'during a restart never leaves a restart pending',
        from: state(restarting()),
        event: { type: 'shutdown' },
        phase: shuttingDown,
        effects: [CANCEL_TIMER],
      },
      {
        name: 'from ready drops the account',
        from: state(ready()),
        event: { type: 'shutdown' },
        phase: shuttingDown,
      },
      {
        name: 'during another shutdown changes nothing',
        from: state(shuttingDown),
        event: { type: 'shutdown' },
        phase: shuttingDown,
      },
      {
        name: 'finishing reports offline',
        from: state(shuttingDown),
        event: { type: 'shutdownFinished' },
        phase: idle,
        effects: [{ type: 'reportOffline' }],
      },
      {
        name: 'finishing after an initialize took over changes nothing',
        from: state(starting()),
        event: { type: 'shutdownFinished' },
        phase: starting(),
      },
    ])
  })

  it('returns the same state when nothing changes', () => {
    const from = state(ready())
    expect(transitionLifecycle(from, { type: 'timerFired' }).state).toBe(from)
  })
})

describe('lifecycle helpers', () => {
  it('only treats a worker on its way as pending', () => {
    expect([idle, starting(), retryWaiting(), ready(), restarting(), halted(), shuttingDown].map(isPending))
      .toEqual([false, true, true, false, true, false, false])
  })

  it('has an account in every phase but idle and shuttingDown', () => {
    expect([idle, starting(), retryWaiting(), ready(), restarting(), halted(), shuttingDown].map(phaseAccountId))
      .toEqual([null, 'a', 'a', 'a', 'a', 'a', null])
  })

  it('clamps the retry delay at the last one', () => {
    expect(initRetryDelay(0)).toBe(INIT_RETRY_DELAYS[0])
    expect(initRetryDelay(100)).toBe(INIT_RETRY_DELAYS.at(-1))
  })
})
