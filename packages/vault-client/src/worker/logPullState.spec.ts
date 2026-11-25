import {
  INITIAL_LOG_PULL_STATE,
  gapRepollDelay,
  hasImmediatePendingPulls,
  isBehindLog,
  transitionLogPull,
  type LogPullEffect,
  type LogPullEvent,
  type LogPullState,
  type ReadPhase,
} from './logPullState'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const NOW = 1_000_000

const idle: ReadPhase = { kind: 'idle' }
const morePages: ReadPhase = { kind: 'morePages' }
const gap = (seq: number, firstSeenAt = NOW, repolls = 0): ReadPhase => ({ kind: 'gap', wait: { seq, firstSeenAt, repolls } })

function state(read: ReadPhase, catchingUp = false): LogPullState {
  return { read, catchingUp }
}

/** A gap at seq 1 whose next row was written `ageMs` before `serverNow` */
function gapFound(ageMs: number, serverNow = NOW, missingSeq = 1): LogPullEvent {
  return { type: 'gapFound', missingSeq, nextCreatedAt: serverNow - ageMs, serverNow }
}

const STALE = SYNC_TIMEOUTS.gapWait

interface Row {
  name: string
  from: LogPullState
  event: LogPullEvent
  to: LogPullState
  effects?: LogPullEffect[]
}

const rows: Row[] = [
  // Gaps
  { name: 'waits at a fresh gap', from: state(idle), event: gapFound(0), to: state(gap(1)) },
  {
    name: 'counts a repoll at the same gap',
    from: state(gap(1)),
    event: gapFound(0, NOW + 1000),
    to: state(gap(1, NOW, 1)),
  },
  {
    name: 'starts a new wait at a different gap',
    from: state(gap(1, NOW - 5000, 3)),
    event: gapFound(0, NOW, 4),
    to: state(gap(4)),
  },
  {
    name: 'passes a gap whose next row is old, and asks for a recovery sync',
    from: state(idle),
    event: gapFound(STALE),
    to: state(idle),
    effects: ['passGap', 'recoverLostRows'],
  },
  {
    name: 'passes a fresh gap that has lasted the whole wait',
    from: state(gap(1)),
    event: gapFound(0, NOW + STALE),
    to: state(idle),
    effects: ['passGap', 'recoverLostRows'],
  },
  {
    name: 'expects stale gaps while catching up',
    from: state(idle, true),
    event: gapFound(STALE),
    to: state(idle, true),
    effects: ['passGap'],
  },
  {
    name: 'still waits at a fresh gap while catching up',
    from: state(idle, true),
    event: gapFound(0),
    to: state(gap(1), true),
  },
  { name: 'clears the gap once its row is read', from: state(gap(1)), event: { type: 'rowRead' }, to: state(idle) },

  // Pages
  {
    name: 'keeps the gap when a page stops at it',
    from: state(gap(1)),
    event: { type: 'pageRead', stoppedAtGap: true, hasMore: true },
    to: state(gap(1)),
  },
  {
    name: 'records more pages',
    from: state(idle),
    event: { type: 'pageRead', stoppedAtGap: false, hasMore: true },
    to: state(morePages),
  },
  {
    name: 'stays catching up until the end of the log',
    from: state(idle, true),
    event: { type: 'pageRead', stoppedAtGap: false, hasMore: true },
    to: state(morePages, true),
  },
  {
    name: 'finishes catching up at the end of the log',
    from: state(morePages, true),
    event: { type: 'pageRead', stoppedAtGap: false, hasMore: false },
    to: state(idle),
  },

  // Catching up: the manifest syncs themselves are demands on ManifestSyncManager
  { name: 'reads a dropped page again at once', from: state(idle), event: { type: 'pageDropped' }, to: state(morePages) },
  {
    name: 'reads the log once catch-up\'s manifest sync has run',
    from: state(morePages),
    event: { type: 'catchUpSynced' },
    to: state(morePages, true),
  },

  // Stopping
  { name: 'forgets where reading stopped on stop', from: state(gap(1), true), event: { type: 'stop' }, to: state(idle, true) },
]

describe('transitionLogPull', () => {
  it.each(rows.map(row => [row.name, row] as const))('%s', (_name, row) => {
    const { state: next, effects } = transitionLogPull(row.from, row.event)

    expect(next).toEqual(row.to)
    expect(effects).toEqual(row.effects ?? [])
  })

  it('returns the same state when nothing changes', () => {
    const from = state(idle, true)

    expect(transitionLogPull(from, { type: 'catchUpSynced' }).state).toBe(from)
  })
})

describe('log pull queries', () => {
  it('polls again at once only for more pages, never for a gap (rule 4)', () => {
    expect(hasImmediatePendingPulls(state(morePages))).toBe(true)
    expect(hasImmediatePendingPulls(state(gap(1)))).toBe(false)
    expect(hasImmediatePendingPulls(state(idle))).toBe(false)
  })

  it('repolls a gap with a growing delay, up to a cap', () => {
    expect(gapRepollDelay(state(idle))).toBeUndefined()
    expect(gapRepollDelay(state(gap(1)))).toBe(SYNC_TIMEOUTS.gapRepollBase)
    expect(gapRepollDelay(state(gap(1, NOW, 1)))).toBe(SYNC_TIMEOUTS.gapRepollBase * 2)
    expect(gapRepollDelay(state(gap(1, NOW, 20)))).toBe(16_000)
  })

  describe('isBehindLog', () => {
    const recent = NOW - 1000

    it('is behind with no finished pull, or one older than the catch-up age', () => {
      expect(isBehindLog(INITIAL_LOG_PULL_STATE, null, NOW)).toBe(true)
      expect(isBehindLog(INITIAL_LOG_PULL_STATE, recent, NOW)).toBe(false)
      expect(isBehindLog(INITIAL_LOG_PULL_STATE, recent, recent + SYNC_TIMEOUTS.logCatchUpAge + 1)).toBe(true)
    })

    it('is not behind while catching up', () => {
      expect(isBehindLog(state(idle, true), null, NOW)).toBe(false)
    })
  })
})
