import { formatDistanceStrict } from 'date-fns'
import type { StuckItems, StuckReason, SyncProgress, SyncStatus } from '@vault/client'

export type SyncTone = 'synced' | 'unknown' | 'pending' | 'offline' | 'warning' | 'error'

export interface SyncSummary {
  tone: SyncTone
  /** Short text for the app bar chip, or null to show just the icon */
  label: string | null
  headline: string
  details: string[]
}

function pluralItems(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`
}

/** What holds up stuck items, in the order the details list them. Both snapshot reasons read the same. */
const STUCK_REASONS: Array<{ reasons: StuckReason[]; text: string }> = [
  { reasons: ['awaitingHeads'], text: 'waiting to download the latest copy from the server' },
  { reasons: ['awaitingSnapshot', 'snapshotOnly'], text: 'waiting to upload a full copy' },
  { reasons: ['unloadable'], text: "can't be read on this device" },
  { reasons: ['unknown'], text: 'not accepted by the server yet' },
]

const STUCK_RETRY_DETAIL = "Flock will keep retrying. Items it can't fix move to Settings → Corrupted data recovery."

function countStuck(stuckItems: StuckItems | undefined): number {
  return Object.values(stuckItems ?? {}).reduce((total, count) => total + (count ?? 0), 0)
}

/** One line per reason items are stuck, then the rest still waiting, and that Flock is retrying */
function describeStuck(stuckItems: StuckItems, pending: number): string[] {
  const lines = STUCK_REASONS.flatMap(({ reasons, text }) => {
    const count = reasons.reduce((total, reason) => total + (stuckItems[reason] ?? 0), 0)
    return count > 0 ? [`${pluralItems(count)} ${text}`] : []
  })
  const others = pending - countStuck(stuckItems)
  if (others > 0) lines.push(`${others} other ${others === 1 ? 'item' : 'items'} waiting to sync`)
  lines.push(STUCK_RETRY_DETAIL)
  return lines
}

/** "Last synced 5 minutes ago", for the sync details */
export function describeLastSynced(lastSyncedAt: number | null, now: number): string {
  if (lastSyncedAt === null) return 'Not synced on this device yet'
  if (now - lastSyncedAt < 60_000) return 'Last synced just now'
  return `Last synced ${formatDistanceStrict(lastSyncedAt, now)} ago`
}

/**
 * What the app bar shows about sync: whether this device's changes have reached the server, so
 * someone moving to another device can tell whether this one pushed.
 */
export function summariseSync(status: SyncStatus, progress: SyncProgress | null): SyncSummary {
  const pending = progress?.pendingItems ?? 0
  const quarantined = progress?.quarantinedItems ?? 0
  const stuck = countStuck(progress?.stuckItems)
  const quarantineDetail = quarantined > 0
    ? `${pluralItems(quarantined)} couldn't sync and need attention (Settings → Corrupted data recovery)`
    : null
  const withQuarantine = (details: string[]) => (quarantineDetail ? [...details, quarantineDetail] : details)

  if (status === 'dead') {
    return {
      tone: 'error',
      label: 'Sync stopped',
      headline: 'Sync has stopped',
      details: withQuarantine([
        pending > 0
          ? `Changes to ${pluralItems(pending)} haven't synced. Reload to try again.`
          : 'Changes are saved on this device. Reload to start syncing again.',
      ]),
    }
  }

  if (status === 'offline') {
    return {
      tone: 'offline',
      label: pending > 0 ? `Offline · ${pending}` : 'Offline',
      headline: 'Offline',
      details: withQuarantine([
        pending > 0
          ? `${pluralItems(pending)} saved on this device will sync when you're back online`
          : 'Changes are saved on this device and will sync when you reconnect',
      ]),
    }
  }

  if (status === 'degraded') {
    return {
      tone: 'warning',
      label: pending > 0 ? `Sync issue · ${pending}` : 'Sync issue',
      headline: 'Sync is having trouble',
      details: withQuarantine([
        pending > 0
          ? `${pluralItems(pending)} waiting to sync. Flock will keep retrying.`
          : 'Flock will keep retrying.',
      ]),
    }
  }

  if (quarantined > 0) {
    return {
      tone: 'warning',
      label: `${quarantined} not syncing`,
      headline: `${pluralItems(quarantined)} can't sync`,
      details: withQuarantine(
        stuck > 0 && progress?.stuckItems
          ? describeStuck(progress.stuckItems, pending)
          : pending > 0 ? [`${pluralItems(pending)} waiting to sync`] : [],
      ),
    }
  }

  // Waiting this long, they won't "sync shortly"
  if (stuck > 0 && progress?.stuckItems) {
    return {
      tone: 'warning',
      label: `${stuck} delayed`,
      headline: `${pluralItems(stuck)} ${stuck === 1 ? "hasn't" : "haven't"} synced for over a day`,
      details: describeStuck(progress.stuckItems, pending),
    }
  }

  if (pending > 0) {
    return {
      tone: 'pending',
      label: `${pending} waiting`,
      headline: `${pluralItems(pending)} waiting to sync`,
      details: [status === 'syncing' ? 'Syncing now…' : 'They will sync shortly'],
    }
  }

  if (!progress) {
    return { tone: 'unknown', label: null, headline: 'Checking sync…', details: [] }
  }

  return { tone: 'synced', label: null, headline: 'All changes synced', details: [] }
}
