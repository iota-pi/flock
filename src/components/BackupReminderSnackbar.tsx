import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import download from 'js-file-download'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'

import {
  isBackupReminderDue,
  quietBackupReminder,
  readBackupReminderQuietUntil,
  subscribeBackupReminder,
} from '../app/vault/backupReminderStore'
import useBackupAndRestore, { BACKUP_FILE_NAME } from '../hooks/useBackupAndRestore'
import { useToday } from '../hooks/useToday'
import { useAppStore } from '../state/store'
import { createLogger } from '../utils/logger'

const log = createLogger('BackupReminderSnackbar')

/** Long enough for the first sync after opening the app to clear an out-of-date last sync time */
export const BACKUP_REMINDER_DELAY_MS = 30_000

/**
 * Suggests a backup when this device has unsynced changes and has gone a month without syncing or
 * being backed up. It keeps out of the way of the snackbars that need action, and goes away by
 * itself if a sync completes.
 */
export default function BackupReminderSnackbar() {
  const account = useAppStore(state => state.account)
  // Undefined until the worker has reported
  const lastSyncedAt = useAppStore(state => state.syncProgress?.lastSyncedAt)
  const unsyncedItems = useAppStore(state => (
    (state.syncProgress?.pendingItems ?? 0) + (state.syncProgress?.quarantinedItems ?? 0)
  ))
  const otherSnackbarOpen = useAppStore(state => (
    state.isQuotaExceeded || (state.appUpdateReady && !state.appUpdateDismissed)
  ))
  const setMessage = useAppStore(state => state.setMessage)
  const quietUntil = useSyncExternalStore(subscribeBackupReminder, () => readBackupReminderQuietUntil(account))
  const today = useToday()
  const { actions: { handleExport } } = useBackupAndRestore({ setMessage })

  const [settled, setSettled] = useState(false)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), BACKUP_REMINDER_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    // Gives a device that has never synced a time to count the month from
    if (lastSyncedAt === null && quietUntil === null) quietBackupReminder(account)
  }, [account, lastSyncedAt, quietUntil])

  const handleBackUp = useCallback(async () => {
    setExporting(true)
    try {
      download(await handleExport(), BACKUP_FILE_NAME)
    } catch (err) {
      log.error('Export failed', err)
    } finally {
      setExporting(false)
    }
  }, [handleExport])

  const handleDismiss = useCallback(() => quietBackupReminder(account), [account])

  const due = lastSyncedAt !== undefined
    && isBackupReminderDue({ unsyncedItems, lastSyncedAt, quietUntil, now: today.getTime() })

  return (
    <Snackbar
      open={settled && due && !otherSnackbarOpen}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ mb: { xs: 8, sm: 3 } }}
    >
      <Alert
        severity="info"
        variant="filled"
        action={
          <>
            <Button
              color="inherit"
              size="small"
              onClick={handleDismiss}
              sx={{ textTransform: 'none' }}
            >
              Not now
            </Button>
            <Button
              color="inherit"
              size="small"
              variant="outlined"
              disabled={exporting}
              onClick={() => void handleBackUp()}
              sx={{ ml: 1, borderColor: 'rgba(255,255,255,0.7)', textTransform: 'none', fontWeight: 600 }}
            >
              Back up
            </Button>
          </>
        }
        sx={{ width: '100%', alignItems: 'center' }}
      >
        This device hasn&apos;t synced or been backed up in over a month.
      </Alert>
    </Snackbar>
  )
}
