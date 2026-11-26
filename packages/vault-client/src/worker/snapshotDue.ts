import { SYNC_TIMEOUTS } from '../shared/syncConfig'

/**
 * When the dirty items' snapshots are due, as one state value and a pure transition function.
 * `ItemSyncState` holds which items are dirty; `SnapshotSchedule` holds this state and applies the
 * transitions for its callers.
 */

export interface SnapshotDueState {
  /** A debounce after the latest edit, which each edit puts off again */
  debounceDueAt: number | undefined
  /** A max wait after the first edit, which bounds the debounce for steady editing */
  maxWaitDueAt: number | undefined
  /** The earliest due time a request with its own delay asked for, which edits don't put off */
  requestedDueAt: number | undefined
  /** An upload failed, so the next poll tries again without a poll being brought forward */
  retryAtNextPoll: boolean
  /** Nothing is due before this, after the server turned uploads away for the account's quota */
  notBefore: number
}

export type SnapshotDueEvent =
  /** An item was queued. With `delayMs`, it's due after that however later edits come. */
  | { type: 'marked'; delayMs?: number }
  /**
   * Make every dirty item due now. Only `pastQuota` makes them due during a quota deferral, for the
   * page closing or the user asking; a request from inside sync waits the deferral out.
   */
  | { type: 'requestNow'; pastQuota: boolean }
  /** An upload took every dirty item, so nothing stays due */
  | { type: 'uploadStarted' }
  /** An upload failed, leaving its items dirty for the next poll */
  | { type: 'uploadFailed' }
  /** The server turned uploads away for the quota: none goes up, in either phase, before `until` */
  | { type: 'refused'; until: number }
  /** A new rewrite tries once, even during a quota deferral: storage may have freed up */
  | { type: 'deferralLifted' }
  /** Items left the queue without an upload: nothing stays due once none is left */
  | { type: 'dequeued' }

export interface SnapshotDueContext {
  now: number
  /** How many items are queued, after the change the event reports */
  dirtyCount: number
}

export const INITIAL_SNAPSHOT_DUE_STATE: SnapshotDueState = {
  debounceDueAt: undefined,
  maxWaitDueAt: undefined,
  requestedDueAt: undefined,
  retryAtNextPoll: false,
  notBefore: 0,
}

function clearDue(state: SnapshotDueState): SnapshotDueState {
  return { ...state, debounceDueAt: undefined, maxWaitDueAt: undefined, requestedDueAt: undefined, retryAtNextPoll: false }
}

/** The next state. Returns `state` itself when nothing changes. */
export function transitionSnapshotDue(
  state: SnapshotDueState,
  event: SnapshotDueEvent,
  ctx: SnapshotDueContext,
): SnapshotDueState {
  const { now } = ctx
  switch (event.type) {
    case 'marked': {
      const maxWaitDueAt = state.maxWaitDueAt ?? now + SYNC_TIMEOUTS.snapshotMaxWait
      if (event.delayMs === undefined) {
        return { ...state, debounceDueAt: now + SYNC_TIMEOUTS.snapshotDebounce, maxWaitDueAt }
      }
      const requestedDueAt = Math.min(state.requestedDueAt ?? Number.POSITIVE_INFINITY, now + event.delayMs)
      return { ...state, requestedDueAt, maxWaitDueAt }
    }

    case 'requestNow':
      return { ...state, requestedDueAt: now, notBefore: event.pastQuota ? 0 : state.notBefore }

    case 'uploadStarted':
      return clearDue(state)

    case 'uploadFailed':
      return state.retryAtNextPoll ? state : { ...state, retryAtNextPoll: true }

    case 'refused':
      return { ...state, notBefore: event.until, retryAtNextPoll: true }

    case 'deferralLifted':
      return state.notBefore === 0 ? state : { ...state, notBefore: 0 }

    case 'dequeued':
      return ctx.dirtyCount === 0 ? clearDue(state) : state
  }
}

/**
 * When the next upload is due, for scheduling a poll, or undefined if none is. An upload left to
 * retry at the next poll doesn't count: it waits for the poll's own cadence or backoff.
 */
export function snapshotDueAt(state: SnapshotDueState, ctx: SnapshotDueContext): number | undefined {
  if (ctx.dirtyCount === 0) return undefined
  const dueAt = Math.min(
    state.debounceDueAt ?? Number.POSITIVE_INFINITY,
    state.maxWaitDueAt ?? Number.POSITIVE_INFINITY,
    state.requestedDueAt ?? Number.POSITIVE_INFINITY,
  )
  return Number.isFinite(dueAt) ? Math.max(dueAt, state.notBefore) : undefined
}

/** Whether a poll now should upload the dirty items' snapshots */
export function isSnapshotDue(state: SnapshotDueState, ctx: SnapshotDueContext): boolean {
  if (ctx.dirtyCount === 0) return false
  if (state.retryAtNextPoll && !isSnapshotDeferred(state, ctx.now)) return true
  const dueAt = snapshotDueAt(state, ctx)
  return dueAt !== undefined && dueAt <= ctx.now
}

/** Whether uploads are waiting out a quota deferral */
export function isSnapshotDeferred(state: SnapshotDueState, now: number): boolean {
  return now < state.notBefore
}
