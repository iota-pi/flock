import { useCallback, useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'

import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../app/vault/syncBridge'

function describeUnpushed(count: number): string {
  if (count === 0) return 'Every change on this device has already been synced, so nothing will be lost.'
  const changes = count === 1 ? '1 change' : `${count} changes`
  return `${changes} made on this device haven't been synced yet and will be lost.`
}

/**
 * Shown when this device's encrypted local data can't be opened, for example after its key was lost.
 * The data is never discarded without the user confirming here.
 */
export default function LocalDataUnavailableDialog() {
  const details = useAppStore(state => state.localDataUnavailable)
  const account = useAppStore(state => state.account)
  const setLocalDataUnavailable = useAppStore(state => state.setLocalDataUnavailable)
  const setMessage = useAppStore(state => state.setMessage)
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)
  const [working, setWorking] = useState(false)

  const run = useCallback(async (action: () => Promise<void>) => {
    if (!account) return
    setWorking(true)
    setLocalDataUnavailable(null)
    try {
      await action()
    } catch (error) {
      setMessage({ severity: 'error', message: (error as Error).message || 'Sync could not be started.' })
    } finally {
      setWorking(false)
      setConfirmingDiscard(false)
    }
  }, [account, setLocalDataUnavailable, setMessage])

  const handleRetry = useCallback(
    () => run(() => SyncBridge.initialize(account)),
    [account, run],
  )
  const handleDiscard = useCallback(
    () => run(() => SyncBridge.discardLocalDataAndRestart(account)),
    [account, run],
  )

  return (
    <Dialog open={details !== null} maxWidth="xs" fullWidth aria-labelledby="local-data-unavailable-title">
      <DialogTitle id="local-data-unavailable-title">
        This device&apos;s data can&apos;t be opened
      </DialogTitle>

      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          Flock keeps an encrypted copy of your data on this device, and the key that opens it couldn&apos;t
          be loaded. Sync is paused until this is resolved.
        </Typography>
        {confirmingDiscard ? (
          <Alert severity="warning">
            Your data will be downloaded again from the server. {describeUnpushed(details?.unpushedChanges ?? 0)}
          </Alert>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Try again first. If it keeps failing, you can discard this device&apos;s copy and download your
            data from the server again.
          </Typography>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        {confirmingDiscard ? (
          <>
            <Button onClick={() => setConfirmingDiscard(false)} disabled={working}>
              Cancel
            </Button>
            <Button
              variant="contained"
              color="warning"
              onClick={handleDiscard}
              disabled={working}
              startIcon={working ? <CircularProgress size={14} color="inherit" /> : undefined}
            >
              Discard and download
            </Button>
          </>
        ) : (
          <>
            <Button color="warning" onClick={() => setConfirmingDiscard(true)} disabled={working}>
              Discard local data
            </Button>
            <Button
              variant="contained"
              onClick={handleRetry}
              disabled={working}
              startIcon={working ? <CircularProgress size={14} color="inherit" /> : undefined}
            >
              Try again
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  )
}
