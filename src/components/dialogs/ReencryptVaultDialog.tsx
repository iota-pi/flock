import { useState, useCallback } from 'react'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import LinearProgress from '@mui/material/LinearProgress'
import Typography from '@mui/material/Typography'
import Box from '@mui/material/Box'

import { reencryptAllItems } from 'src/api/vault/reencrypt'
import { useAppStore } from 'src/state/store'

interface Props {
  open: boolean
  onClose: () => void
}

export default function ReencryptVaultDialog({ open, onClose }: Props) {
  const account = useAppStore(state => state.account)
  const setMessage = useAppStore(state => state.setMessage)
  const [status, setStatus] = useState<'idle' | 'running' | 'completed' | 'error'>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [errorMsg, setErrorMsg] = useState('')

  const handleClose = useCallback(() => {
    if (status === 'running') return
    setStatus('idle')
    setProgress({ done: 0, total: 0 })
    setErrorMsg('')
    onClose()
  }, [status, onClose])

  const handleStart = useCallback(async () => {
    setStatus('running')
    setErrorMsg('')
    try {
      await reencryptAllItems(account, (done, total) => {
        setProgress({ done, total })
      })
      setStatus('completed')
      setMessage({
        severity: 'success',
        message: 'All vault items re-encrypted successfully.',
      })
      handleClose()
    } catch (err) {
      console.error('[ReencryptVaultDialog] reencryptAllItems failed', err)
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'An unexpected error occurred during re-encryption.')
    }
  }, [account, handleClose, setMessage])

  const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      fullWidth
      maxWidth="xs"
    >
      <DialogTitle>Re-encrypt Vault Items</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
          <Typography variant="body2" color="textSecondary">
            To fully secure your vault after a password change, it is highly recommended to re-encrypt all of your items with a new vault key. This rotates the data key and prunes old sync history from the server.
          </Typography>

          {status === 'running' && (
            <Box sx={{ mt: 1 }}>
              <Typography variant="body2" sx={{ mb: 1, fontWeight: 500 }} data-cy="reencrypt-progress-text">
                Re-encrypting items: {progress.done} / {progress.total} ({percent}%)
              </Typography>
              <LinearProgress variant="determinate" value={percent} sx={{ height: 8, borderRadius: 4 }} data-cy="reencrypt-progress-bar" />
            </Box>
          )}

          {status === 'error' && (
            <Typography variant="body2" color="error" role="alert" data-cy="reencrypt-error-text">
              Error: {errorMsg}
            </Typography>
          )}
        </Box>
      </DialogContent>
      <DialogActions>
        {status !== 'running' && (
          <Button
            onClick={handleClose}
            variant="outlined"
            fullWidth
            data-cy="reencrypt-dialog-skip"
          >
            Skip for now
          </Button>
        )}
        <Button
          onClick={handleStart}
          variant="contained"
          disabled={status === 'running'}
          fullWidth
          data-cy="reencrypt-dialog-start"
        >
          {status === 'running' ? 'Re-encrypting...' : status === 'error' ? 'Retry' : 'Start'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
