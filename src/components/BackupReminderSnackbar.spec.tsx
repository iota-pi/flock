import { act, fireEvent, render, screen } from '@testing-library/react'
import BackupReminderSnackbar, { BACKUP_REMINDER_DELAY_MS } from './BackupReminderSnackbar'
import {
  BACKUP_REMINDER_INTERVAL_MS,
  clearBackupReminder,
  quietBackupReminder,
  readBackupReminderQuietUntil,
} from '../app/vault/backupReminderStore'
import * as backupModule from '../hooks/useBackupAndRestore'
import { useAppStore } from '../state/store'
import { spyOnExports } from '../utils/testUtils'

describe('BackupReminderSnackbar', () => {
  const account = 'acct-1'
  const handleExport = vi.fn(async () => {
    quietBackupReminder(account)
    return '{}'
  })
  const staleSync = () => Date.now() - BACKUP_REMINDER_INTERVAL_MS - 2 * 24 * 60 * 60 * 1000

  function setLastSynced(lastSyncedAt: number | null, pendingItems = 1, quarantinedItems = 0) {
    act(() => {
      useAppStore.setState({ syncProgress: { pendingItems, quarantinedItems, lastSyncedAt } })
    })
  }

  function renderSettled() {
    const result = render(<BackupReminderSnackbar />)
    act(() => {
      vi.advanceTimersByTime(BACKUP_REMINDER_DELAY_MS)
    })
    return result
  }

  beforeEach(() => {
    vi.useFakeTimers()
    handleExport.mockClear()
    clearBackupReminder(account)
    spyOnExports(backupModule, {
      default: () => ({
        actions: { handleExport, handleConfirmImport: vi.fn(), handleConfirmRestore: vi.fn() },
      }),
    })
    act(() => {
      useAppStore.setState({ account, syncProgress: null, isQuotaExceeded: false, appUpdateReady: false })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('suggests a backup when the last sync is over a month old', () => {
    setLastSynced(staleSync())
    renderSettled()
    expect(screen.getByText(/hasn't synced or been backed up/)).toBeDefined()
  })

  it('counts changes held for recovery, which are not syncing either', () => {
    setLastSynced(staleSync(), 0, 1)
    renderSettled()
    expect(screen.getByText(/hasn't synced or been backed up/)).toBeDefined()
  })

  it('shows nothing when there are no unsynced changes', () => {
    setLastSynced(staleSync(), 0)
    renderSettled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('waits before appearing, so the first sync after opening can finish', () => {
    setLastSynced(staleSync())
    render(<BackupReminderSnackbar />)
    act(() => {
      vi.advanceTimersByTime(BACKUP_REMINDER_DELAY_MS - 1)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows nothing until the worker has reported, or after a recent sync', () => {
    const { rerender } = renderSettled()
    expect(screen.queryByRole('alert')).toBeNull()

    setLastSynced(Date.now())
    rerender(<BackupReminderSnackbar />)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows nothing within a month of a backup', () => {
    quietBackupReminder(account)
    setLastSynced(staleSync())
    renderSettled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stays out of the way of the other snackbars', () => {
    setLastSynced(staleSync())
    act(() => {
      useAppStore.setState({ appUpdateReady: true })
    })
    renderSettled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('starts counting the month on a device that has never synced', () => {
    setLastSynced(null)
    renderSettled()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(readBackupReminderQuietUntil(account)).not.toBeNull()
  })

  it('stays quiet for a month after being dismissed', () => {
    setLastSynced(staleSync())
    renderSettled()
    fireEvent.click(screen.getByRole('button', { name: /not now/i }))
    expect(readBackupReminderQuietUntil(account)).toBeGreaterThan(Date.now())
    expect(handleExport).not.toHaveBeenCalled()
  })

  it('creates a backup from the reminder', async () => {
    setLastSynced(staleSync())
    renderSettled()
    fireEvent.click(screen.getByRole('button', { name: /back up/i }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(handleExport).toHaveBeenCalledTimes(1)
    expect(readBackupReminderQuietUntil(account)).toBeGreaterThan(Date.now())
  })
})
