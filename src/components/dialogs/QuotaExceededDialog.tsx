import { useState, useCallback } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../sync/client/SyncBridge'
import { ResetIcon, SyncIcon, DownloadIcon } from '../Icons'

interface Props {
  open: boolean
  onClose: () => void
}

export default function QuotaExceededDialog({ open, onClose }: Props) {
  const syncStatus = useAppStore(state => state.syncStatus)
  const isOnline = syncStatus !== 'offline'
  const items = useAppStore(state => state.items)

  const [isRetryingSave, setIsRetryingSave] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [copiedBackup, setCopiedBackup] = useState(false)

  const handleRetrySave = useCallback(async () => {
    setIsRetryingSave(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const result = await SyncBridge.retrySave()
      if (result.success) {
        setSuccessMessage('Changes successfully saved to this device!')
        setTimeout(() => {
          onClose()
        }, 1200)
      } else {
        setErrorMessage(
          result.error ||
            'Device storage is still full. Please free up more space on your device and try again.'
        )
      }
    } catch (err) {
      setErrorMessage((err as Error).message || 'Failed to retry saving changes.')
    } finally {
      setIsRetryingSave(false)
    }
  }, [onClose])

  const handleSyncNow = useCallback(async () => {
    setIsSyncing(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      await SyncBridge.pushSnapshots()
      await SyncBridge.flushSync()
      setSuccessMessage('Cloud sync initiated successfully!')
    } catch (err) {
      setErrorMessage((err as Error).message || 'Failed to sync to server.')
    } finally {
      setIsSyncing(false)
    }
  }, [])

  const handleCopyBackup = useCallback(() => {
    try {
      const dataStr = JSON.stringify(items, null, 2)
      void navigator.clipboard.writeText(dataStr)
      setCopiedBackup(true)
      setTimeout(() => setCopiedBackup(false), 3000)
    } catch (_) {
      setErrorMessage('Failed to copy backup to clipboard.')
    }
  }, [items])

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 600 }}>
        Storage Full: Changes Stored in Memory Only
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 0.5 }}>
          <Alert severity="error">
            Your device or browser storage is full. Flock cannot save your changes to local storage.
            If you close or refresh this tab before resolving this, <strong>your recent changes will be lost</strong>.
          </Alert>

          {errorMessage && (
            <Alert severity="warning" onClose={() => setErrorMessage(null)}>
              {errorMessage}
            </Alert>
          )}

          {successMessage && (
            <Alert severity="success" onClose={() => setSuccessMessage(null)}>
              {successMessage}
            </Alert>
          )}

          {/* Option 1: Free up space and Retry Save */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Option 1: Free Up Device Space & Retry Save
              </Typography>
              <Typography variant="body2" color="textSecondary">
                Delete unused apps, videos, or downloads on your device. Once space is freed, click
                below to save your changes to this device.
              </Typography>
              <Box sx={{ pt: 1 }}>
                <Button
                  variant="contained"
                  color="primary"
                  size="small"
                  disabled={isRetryingSave}
                  startIcon={
                    isRetryingSave ? <CircularProgress size={16} color="inherit" /> : <ResetIcon />
                  }
                  onClick={() => void handleRetrySave()}
                >
                  {isRetryingSave ? 'Saving to Device...' : 'Retry Save'}
                </Button>
              </Box>
            </Stack>
          </Paper>

          {/* Option 2: Connect to internet and sync */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Option 2: Sync to Cloud Server
              </Typography>
              <Typography variant="body2" color="textSecondary">
                Connect to Wi-Fi or cellular data to upload your unsynced changes directly to the
                cloud server without needing local disk space.
              </Typography>
              <Box sx={{ pt: 1 }}>
                <Button
                  variant="outlined"
                  color="primary"
                  size="small"
                  disabled={!isOnline || isSyncing}
                  startIcon={
                    isSyncing ? <CircularProgress size={16} color="inherit" /> : <SyncIcon />
                  }
                  onClick={() => void handleSyncNow()}
                >
                  {isSyncing
                    ? 'Syncing to Cloud...'
                    : isOnline
                      ? 'Sync to Cloud Now'
                      : 'Offline (Connect to Internet)'}
                </Button>
              </Box>
            </Stack>
          </Paper>

          {/* Option 3: Emergency Backup */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={1}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Option 3: Emergency Data Backup
              </Typography>
              <Typography variant="body2" color="textSecondary">
                Copy your current prayer and item data to your clipboard as JSON so you {"don't"} lose
                anything if you need to close the browser.
              </Typography>
              <Box sx={{ pt: 1 }}>
                <Button
                  variant="outlined"
                  color="secondary"
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={handleCopyBackup}
                >
                  {copiedBackup ? 'Copied to Clipboard!' : 'Copy Data to Clipboard'}
                </Button>
              </Box>
            </Stack>
          </Paper>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} color="inherit">
          Close (Keep in Memory)
        </Button>
      </DialogActions>
    </Dialog>
  )
}
