import { formatDistanceStrict } from 'date-fns'
import type { SyncProgress, SyncStatus } from '@vault/client'

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
      details: withQuarantine(pending > 0 ? [`${pluralItems(pending)} waiting to sync`] : []),
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
