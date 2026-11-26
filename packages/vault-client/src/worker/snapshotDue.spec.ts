import {
  INITIAL_SNAPSHOT_DUE_STATE,
  isSnapshotDeferred,
  isSnapshotDue,
  snapshotDueAt,
  transitionSnapshotDue,
  type SnapshotDueEvent,
  type SnapshotDueState,
} from './snapshotDue'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

const DEBOUNCE = SYNC_TIMEOUTS.snapshotDebounce
const MAX_WAIT = SYNC_TIMEOUTS.snapshotMaxWait
const RESTORED = SYNC_TIMEOUTS.restoredSnapshotDelay
const UNTIL = 10_000

/** An event at a time, with how many items are queued once it has happened (1 unless given) */
type Step = [at: number, event: SnapshotDueEvent, dirtyCount?: number]

interface Row {
  name: string
  steps: Step[]
  /** How many items are queued when the result is read */
  dirtyCount?: number
  nextDueAt: number | undefined
  /** Whether a poll at each time uploads */
  dueAt?: Record<number, boolean>
  /** Whether uploads wait out a quota deferral at each time */
  deferredAt?: Record<number, boolean>
}

const marked = (delayMs?: number): SnapshotDueEvent => ({ type: 'marked', delayMs })
const requestNow = (pastQuota: boolean): SnapshotDueEvent => ({ type: 'requestNow', pastQuota })
const uploadStarted: SnapshotDueEvent = { type: 'uploadStarted' }
const uploadFailed: SnapshotDueEvent = { type: 'uploadFailed' }
const refused: SnapshotDueEvent = { type: 'refused', until: UNTIL }
const deferralLifted: SnapshotDueEvent = { type: 'deferralLifted' }
const dequeued: SnapshotDueEvent = { type: 'dequeued' }

const failedUpload: Step[] = [[0, marked(0)], [0, uploadStarted], [0, uploadFailed]]
const refusedUpload: Step[] = [[0, marked(0)], [0, uploadStarted], [0, refused]]

function steadyEdits(): Step[] {
  const steps: Step[] = []
  for (let at = 0; at < MAX_WAIT; at += DEBOUNCE / 2) {
    steps.push([at, marked()])
  }
  return steps
}

const rows: Row[] = [
  {
    name: 'an edit: due a debounce after it',
    steps: [[0, marked()]],
    nextDueAt: DEBOUNCE,
    dueAt: { [DEBOUNCE - 1]: false, [DEBOUNCE]: true },
  },
  {
    name: 'another edit before the debounce ends: puts it off',
    steps: [[0, marked()], [DEBOUNCE / 2, marked()]],
    nextDueAt: DEBOUNCE / 2 + DEBOUNCE,
  },
  {
    name: 'steady editing: due at the max wait after the first edit',
    steps: steadyEdits(),
    nextDueAt: MAX_WAIT,
  },
  {
    name: 'a request with its own delay: due after it',
    steps: [[0, marked(2000)]],
    nextDueAt: 2000,
    dueAt: { 1999: false, 2000: true },
  },
  {
    name: 'a request with its own delay, then an edit: the edit does not put it off',
    steps: [[0, marked(200)], [100, marked()]],
    nextDueAt: 200,
  },
  {
    name: 'restored at startup, then edits: still due after restoredSnapshotDelay',
    steps: [[0, marked(RESTORED)], [RESTORED / 2, marked()]],
    nextDueAt: RESTORED,
  },
  {
    name: 'nothing queued: never due',
    steps: [[0, marked(0)]],
    dirtyCount: 0,
    nextDueAt: undefined,
    dueAt: { 0: false },
  },
  {
    name: 'requested now: due at once',
    steps: [[0, marked()], [100, requestNow(false)]],
    nextDueAt: 100,
    dueAt: { 100: true },
  },
  {
    name: 'an upload started: nothing stays due',
    steps: [[0, marked(0)], [0, uploadStarted]],
    nextDueAt: undefined,
    dueAt: { 0: false, [MAX_WAIT]: false },
  },
  {
    // A retry waits for the poll's own cadence or backoff, so a failing upload can't loop polls
    name: 'an upload failed: due at the next poll, without bringing one forward',
    steps: failedUpload,
    nextDueAt: undefined,
    dueAt: { 0: true },
  },
  {
    name: 'an upload failed, then an edit: brings a poll forward again',
    steps: [...failedUpload, [0, marked()]],
    nextDueAt: DEBOUNCE,
  },
  {
    name: 'an upload failed, then the next upload started: stops retrying',
    steps: [...failedUpload, [0, uploadStarted]],
    nextDueAt: undefined,
    dueAt: { 0: false },
  },
  {
    name: 'refused for the quota: not due before the deferral ends, then at the next poll',
    steps: refusedUpload,
    nextDueAt: undefined,
    dueAt: { [UNTIL - 1]: false, [UNTIL]: true },
    deferredAt: { [UNTIL - 1]: true, [UNTIL]: false },
  },
  {
    name: 'refused, then an edit: due no sooner than the deferral ends',
    steps: [...refusedUpload, [0, marked(0)]],
    nextDueAt: UNTIL,
    dueAt: { 5000: false },
  },
  {
    // C5: otherwise every manifest sync of an account at its quota sends a batch to be refused
    name: 'refused, then the manifest pre-upload: not due before the deferral ends',
    steps: [...refusedUpload, [0, requestNow(false)]],
    nextDueAt: UNTIL,
    dueAt: { 0: false, [UNTIL]: true },
    deferredAt: { 0: true },
  },
  {
    name: 'refused, then the page closing or the user asking: due at once',
    steps: [...refusedUpload, [0, requestNow(true)]],
    nextDueAt: 0,
    dueAt: { 0: true },
    deferredAt: { 0: false },
  },
  {
    name: 'refused, then a new rewrite lifts the deferral: retries at the next poll',
    steps: [...refusedUpload, [0, deferralLifted]],
    nextDueAt: undefined,
    dueAt: { 0: true },
    deferredAt: { 0: false },
  },
  {
    name: 'an item dequeued with others left: still due',
    steps: [[0, marked()], [0, marked()], [0, dequeued]],
    nextDueAt: DEBOUNCE,
  },
  {
    name: 'the last item dequeued, then an edit: starts a fresh max wait',
    steps: [[0, marked()], [0, dequeued, 0], [MAX_WAIT - 1000, marked()]],
    nextDueAt: MAX_WAIT - 1000 + DEBOUNCE,
  },
]

function run(steps: Step[]): SnapshotDueState {
  return steps.reduce(
    (state, [at, event, dirtyCount = 1]) => transitionSnapshotDue(state, event, { now: at, dirtyCount }),
    INITIAL_SNAPSHOT_DUE_STATE,
  )
}

describe('transitionSnapshotDue', () => {
  it.each(rows)('$name', ({ steps, dirtyCount = 1, nextDueAt, dueAt = {}, deferredAt = {} }) => {
    const state = run(steps)

    expect(snapshotDueAt(state, { now: 0, dirtyCount })).toBe(nextDueAt)
    for (const [at, expected] of Object.entries(dueAt)) {
      expect(isSnapshotDue(state, { now: Number(at), dirtyCount }), `due at ${at}`).toBe(expected)
    }
    for (const [at, expected] of Object.entries(deferredAt)) {
      expect(isSnapshotDeferred(state, Number(at)), `deferred at ${at}`).toBe(expected)
    }
  })

  it('returns the same state when nothing changes', () => {
    const state = run([[0, marked()]])
    expect(transitionSnapshotDue(state, dequeued, { now: 0, dirtyCount: 1 })).toBe(state)
    expect(transitionSnapshotDue(state, deferralLifted, { now: 0, dirtyCount: 1 })).toBe(state)
  })
})
