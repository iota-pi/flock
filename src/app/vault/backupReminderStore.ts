const QUIET_UNTIL_KEY_PREFIX = 'flock_backup_reminder_quiet_until_'

/** Dispatched on window when this tab changes the time ('storage' covers other tabs) */
const BACKUP_REMINDER_CHANGED_EVENT = 'flock-backup-reminder-changed'

/** How long without a sync or backup before reminding, and how long a backup or dismissal quiets it */
export const BACKUP_REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

/** When the reminder may next appear for this account, or null if nothing has quieted it */
export function readBackupReminderQuietUntil(account: string): number | null {
  try {
    const quietUntil = Number(localStorage.getItem(QUIET_UNTIL_KEY_PREFIX + account) ?? NaN)
    return Number.isFinite(quietUntil) ? quietUntil : null
  } catch {
    return null
  }
}

/** Holds off the reminder for a full interval, after a backup or when the user dismisses it */
export function quietBackupReminder(account: string, now = Date.now()): void {
  try {
    localStorage.setItem(QUIET_UNTIL_KEY_PREFIX + account, String(now + BACKUP_REMINDER_INTERVAL_MS))
  } catch {
    // The reminder stays up, as there's nowhere to remember the dismissal
  }
  window.dispatchEvent(new CustomEvent(BACKUP_REMINDER_CHANGED_EVENT))
}

export function clearBackupReminder(account: string): void {
  try {
    localStorage.removeItem(QUIET_UNTIL_KEY_PREFIX + account)
  } catch {
    // Nothing to clear if storage can't be reached
  }
}

/** Calls `listener` when the time changes in this tab or another */
export function subscribeBackupReminder(listener: () => void): () => void {
  window.addEventListener(BACKUP_REMINDER_CHANGED_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(BACKUP_REMINDER_CHANGED_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

/**
 * Whether this device has changes only it holds, and has gone a month without either reaching the
 * server or being backed up. A device that has never synced has no time to measure from, so it waits
 * until something has quieted the reminder once and that period has passed.
 */
export function isBackupReminderDue(
  { unsyncedItems, lastSyncedAt, quietUntil, now }: {
    unsyncedItems: number
    lastSyncedAt: number | null
    quietUntil: number | null
    now: number
  },
): boolean {
  if (unsyncedItems === 0) return false
  if (quietUntil === null ? lastSyncedAt === null : now < quietUntil) return false
  return lastSyncedAt === null || now - lastSyncedAt >= BACKUP_REMINDER_INTERVAL_MS
}
