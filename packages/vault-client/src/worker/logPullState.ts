import { SYNC_TIMEOUTS } from '../shared/syncConfig'

/**
 * Where reading the log stands, and which manifest sync it waits for, as one state value and a pure
 * transition function. `SyncLogPuller` owns the cursor and applies entries; `SyncPoller` runs the
 * manifest syncs this asks for. See "Gaps" in docs/sync-design.md.
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

export type ManifestPhase =
  /** Reading normally */
  | 'none'
  /**
   * The server's clock showed this device may be behind the log's TTL, so the page it got was
   * dropped. A manifest sync has to run before the log is read again.
   */
  | 'catchUpDue'
  /** Catch-up's manifest sync has run. Stale gaps are expected until a pull reaches the end of the log. */
  | 'catchingUp'
  /** The puller moved past a lost row. A manifest sync recovers what it held, and stays due until one fetches the manifest. */
  | 'recoveryDue'

export interface LogPullState {
  read: ReadPhase
  manifest: ManifestPhase
}

export type LogPullEvent =
  /** The server's clock shows the device is behind, and the page was dropped */
  | { type: 'behindSeen' }
  /** Catch-up's manifest sync fetched the manifest */
  | { type: 'catchUpSynced' }
  /** The manifest sync a lost row asked for fetched the manifest */
  | { type: 'recoverySynced' }
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
  /** Log the lost rows as an error, since they can't go missing by design */
  | 'reportLostRows'

export interface LogPullTransition {
  state: LogPullState
  effects: LogPullEffect[]
}

export const INITIAL_LOG_PULL_STATE: LogPullState = { read: { kind: 'idle' }, manifest: 'none' }

const IDLE: ReadPhase = { kind: 'idle' }

function unchanged(state: LogPullState): LogPullTransition {
  return { state, effects: [] }
}

/**
 * Whether a manifest sync has to run before this device reads the log. TTL may have removed rows it
 * never read, and the first visible row may still look contiguous. `now` is the server's clock when
 * it's known.
 */
export function needsCatchUpManifest(state: LogPullState, lastPullAt: number | null, now: number): boolean {
  if (state.manifest === 'catchUpDue') return true
  if (state.manifest === 'catchingUp') return false
  return lastPullAt === null || now - lastPullAt > SYNC_TIMEOUTS.logCatchUpAge
}

/** The manifest sync the poller has to run, if any */
export function pendingManifestSync(state: LogPullState): 'catchUp' | 'recovery' | undefined {
  switch (state.manifest) {
    case 'catchUpDue': return 'catchUp'
    case 'recoveryDue': return 'recovery'
    default: return undefined
  }
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
 * stale one is passed, and asks for a manifest sync unless catching up, when stale gaps are expected.
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

  switch (state.manifest) {
    case 'catchingUp':
      return { state: { ...state, read: IDLE }, effects: ['passGap'] }
    case 'catchUpDue':
      // Catch-up's manifest sync recovers the row too
      return { state: { ...state, read: IDLE }, effects: ['passGap', 'reportLostRows'] }
    case 'none':
    case 'recoveryDue':
      return { state: { read: IDLE, manifest: 'recoveryDue' }, effects: ['passGap', 'reportLostRows'] }
  }
}

/** The next state, and what the puller must do. Returns `state` itself when nothing changes. */
export function transitionLogPull(state: LogPullState, event: LogPullEvent): LogPullTransition {
  switch (event.type) {
    case 'behindSeen':
      // A catch-up manifest sync recovers lost rows as well, so it replaces a recovery request
      if (state.manifest === 'catchUpDue' || state.manifest === 'catchingUp') return unchanged(state)
      return { state: { ...state, manifest: 'catchUpDue' }, effects: [] }

    case 'catchUpSynced':
      if (state.manifest === 'catchingUp') return unchanged(state)
      return { state: { ...state, manifest: 'catchingUp' }, effects: [] }

    case 'recoverySynced':
      if (state.manifest !== 'recoveryDue') return unchanged(state)
      return { state: { ...state, manifest: 'none' }, effects: [] }

    case 'gapFound':
      return onGapFound(state, event)

    case 'rowRead':
      if (state.read.kind !== 'gap') return unchanged(state)
      return { state: { ...state, read: IDLE }, effects: [] }

    case 'pageRead': {
      if (event.stoppedAtGap) return unchanged(state)
      if (event.hasMore) return { state: { ...state, read: { kind: 'morePages' } }, effects: [] }
      // Reaching the end of the log finishes catching up
      const manifest = state.manifest === 'catchingUp' ? 'none' : state.manifest
      return { state: { read: IDLE, manifest }, effects: [] }
    }

    case 'stop':
      if (state.read.kind === 'idle') return unchanged(state)
      return { state: { ...state, read: IDLE }, effects: [] }
  }
}
