import type { PendingMark } from './ChangeOutbox'
import type { StuckItems, StuckReason } from '../shared/types'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

/**
 * Counts the marks that have waited longer than `SYNC_TIMEOUTS.stuckPendingAge`, by what holds each
 * up, as the leader's last push recorded it. Returns undefined when none has.
 */
export function countStuckItems(
  marks: readonly PendingMark[],
  now: number,
): StuckItems | undefined {
  const counts: StuckItems = {}
  let hasStuck = false
  for (const mark of marks) {
    if (now - mark.createdAt < SYNC_TIMEOUTS.stuckPendingAge) continue
    const reason: StuckReason = mark.blocked ?? 'unknown'
    counts[reason] = (counts[reason] ?? 0) + 1
    hasStuck = true
  }
  return hasStuck ? counts : undefined
}

/** Whether two counts of stuck items are the same */
export function areStuckItemsEqual(a: StuckItems | undefined, b: StuckItems | undefined): boolean {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]) as Set<StuckReason>
  return Array.from(keys).every(key => a?.[key] === b?.[key])
}
