import {
  BACKUP_REMINDER_INTERVAL_MS,
  clearBackupReminder,
  isBackupReminderDue,
  quietBackupReminder,
  readBackupReminderQuietUntil,
  subscribeBackupReminder,
} from './backupReminderStore'

describe('backupReminderStore', () => {
  const now = 1_800_000_000_000
  const overAMonthAgo = now - BACKUP_REMINDER_INTERVAL_MS - 1
  const due = (lastSyncedAt: number | null, quietUntil: number | null, unsyncedItems = 1) => (
    isBackupReminderDue({ unsyncedItems, lastSyncedAt, quietUntil, now })
  )

  beforeEach(() => {
    clearBackupReminder('a')
  })

  describe('isBackupReminderDue', () => {
    it('is due when the last sync is over a month old and nothing has quieted it', () => {
      expect(due(overAMonthAgo, null)).toBe(true)
    })

    it('is not due when the device has no unsynced changes', () => {
      expect(due(overAMonthAgo, null, 0)).toBe(false)
      expect(due(null, now - 1, 0)).toBe(false)
    })

    it('is not due when the device synced within the month', () => {
      expect(due(now - 1000, null)).toBe(false)
      expect(due(now - 1000, now - 1)).toBe(false)
    })

    it('is not due while quieted by a backup or dismissal', () => {
      expect(due(overAMonthAgo, now + 1)).toBe(false)
    })

    it('comes back once the quiet period ends', () => {
      expect(due(overAMonthAgo, now)).toBe(true)
    })

    it('waits out a quiet period on a device that has never synced', () => {
      expect(due(null, null)).toBe(false)
      expect(due(null, now + 1)).toBe(false)
      expect(due(null, now - 1)).toBe(true)
    })
  })

  it('keeps the quiet period per account until it is cleared', () => {
    expect(readBackupReminderQuietUntil('a')).toBeNull()

    quietBackupReminder('a', now)
    expect(readBackupReminderQuietUntil('a')).toBe(now + BACKUP_REMINDER_INTERVAL_MS)
    expect(readBackupReminderQuietUntil('b')).toBeNull()

    clearBackupReminder('a')
    expect(readBackupReminderQuietUntil('a')).toBeNull()
  })

  it('tells subscribers when the quiet period changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeBackupReminder(listener)

    quietBackupReminder('a', now)
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    quietBackupReminder('a', now)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
