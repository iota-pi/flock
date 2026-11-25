import { SYNC_TIMEOUTS } from '../shared/syncConfig'

/**
 * Where reading the log stands, as one state value and a pure transition function. `SyncLogPuller`
 * owns the cursor and applies entries, and places the manifest syncs these effects ask for on
 * `ManifestSyncManager`, which the poller runs. See "Gaps" in docs/sync-design.md.
 */

const MAX_GAP_REPOLL_MS = 16_000

/** A missing seq this device is waiting for */
export interface GapWait {
  seq: number
  /** The server's clock when the gap was first seen */
  firstSeenAt: number
  repolls: number
}

export type ReadPhase =
  /** No page is known to be waiting: the last read reached the end of the log, or none has finished */
  | { kind: 'idle' }
  /** The last page said the log has more rows */
  | { kind: 'morePages' }
  /** Reading stopped at a missing seq that may still be in flight */
  | { kind: 'gap'; wait: GapWait }

export interface LogPullState {
  read: ReadPhase
  /**
   * Catch-up's manifest sync has run, so stale gaps are expected until a pull reaches the end of the
   * log. Whether a manifest sync is due is `ManifestSyncManager`'s, which holds the puller's demands.
   */
  catchingUp: boolean
}

export type LogPullEvent =
  /** The server's clock showed the device may be behind the log's TTL, so the page was dropped and catch-up demanded */
  | { type: 'pageDropped' }
  /** Catch-up's manifest sync fetched the manifest */
  | { type: 'catchUpSynced' }
  /** The next visible row isn't the one after the cursor, `missingSeq`. `nextCreatedAt` is when that row was written. */
  | { type: 'gapFound'; missingSeq: number; nextCreatedAt: number; serverNow: number }
  /** The row after the cursor was read */
  | { type: 'rowRead' }
  /** A page was processed, stopping at a gap or after its last entry */
  | { type: 'pageRead'; stoppedAtGap: boolean; hasMore: boolean }
  /** The puller is shutting down */
  | { type: 'stop' }

export type LogPullEffect =
  /** Move the cursor past the gap: its rows were lost */
  | 'passGap'
  /**
   * Log the lost rows as an error, since they can't go missing by design, and demand the manifest
   * sync that recovers what they held
   */
  | 'recoverLostRows'

export interface LogPullTransition {
  state: LogPullState
  effects: LogPullEffect[]
}

export const INITIAL_LOG_PULL_STATE: LogPullState = { read: { kind: 'idle' }, catchingUp: false }

const IDLE: ReadPhase = { kind: 'idle' }

function unchanged(state: LogPullState): LogPullTransition {
  return { state, effects: [] }
}

/**
 * Whether this device may be behind the log's TTL by its own record: TTL may have removed rows it
 * never read, and the first visible row may still look contiguous. Catch-up's manifest sync makes up
 * for that, after which stale gaps are expected until the end of the log. `now` is the server's clock
 * when it's known.
 */
export function isBehindLog(state: LogPullState, lastPullAt: number | null, now: number): boolean {
  if (state.catchingUp) return false
  return lastPullAt === null || now - lastPullAt > SYNC_TIMEOUTS.logCatchUpAge
}

/** Only more pages count: waiting on a gap never polls at once (sync rule 4) */
export function hasImmediatePendingPulls(state: LogPullState): boolean {
  return state.read.kind === 'morePages'
}

/** How soon to poll again for a gap, if reading stopped at one */
export function gapRepollDelay(state: LogPullState): number | undefined {
  if (state.read.kind !== 'gap') return undefined
  return Math.min(SYNC_TIMEOUTS.gapRepollBase * 2 ** state.read.wait.repolls, MAX_GAP_REPOLL_MS)
}

/**
 * Decides about a missing seq. A fresh gap may be a transaction not fully visible yet, so it waits. A
 * stale one is passed, and recovered by a manifest sync unless catching up, when stale gaps are
 * expected. A page is never read while catch-up is due: the poller drops it.
 */
function onGapFound(state: LogPullState, event: Extract<LogPullEvent, { type: 'gapFound' }>): LogPullTransition {
  const { read } = state
  const wait: GapWait = read.kind === 'gap' && read.wait.seq === event.missingSeq
    ? { ...read.wait, repolls: read.wait.repolls + 1 }
    : { seq: event.missingSeq, firstSeenAt: event.serverNow, repolls: 0 }

  const isStale = event.serverNow - event.nextCreatedAt >= SYNC_TIMEOUTS.gapWait
    || event.serverNow - wait.firstSeenAt >= SYNC_TIMEOUTS.gapWait
  if (!isStale) {
    return { state: { ...state, read: { kind: 'gap', wait } }, effects: [] }
  }

  // Catching up expects stale gaps: catch-up's manifest sync recovered what they held
  return { state: { ...state, read: IDLE }, effects: state.catchingUp ? ['passGap'] : ['passGap', 'recoverLostRows'] }
}

/** The next state, and what the puller must do. Returns `state` itself when nothing changes. */
export function transitionLogPull(state: LogPullState, event: LogPullEvent): LogPullTransition {
  switch (event.type) {
    case 'pageDropped':
      // The dropped page is read again once catch-up's manifest sync has run
      return { state: { ...state, read: { kind: 'morePages' } }, effects: [] }

    case 'catchUpSynced':
      if (state.catchingUp) return unchanged(state)
      return { state: { ...state, catchingUp: true }, effects: [] }

    case 'gapFound':
      return onGapFound(state, event)

    case 'rowRead':
      if (state.read.kind !== 'gap') return unchanged(state)
      return { state: { ...state, read: IDLE }, effects: [] }

    case 'pageRead': {
      if (event.stoppedAtGap) return unchanged(state)
      if (event.hasMore) return { state: { ...state, read: { kind: 'morePages' } }, effects: [] }
      // Reaching the end of the log finishes catching up
      return { state: { read: IDLE, catchingUp: false }, effects: [] }
    }

    case 'stop':
      if (state.read.kind === 'idle') return unchanged(state)
      return { state: { ...state, read: IDLE }, effects: [] }
  }
}
