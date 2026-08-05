import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { useDataRecovery } from '../../hooks/useDataRecovery'


interface Props {
  onClose: () => void
  open: boolean
}

function DataRecoveryDialog({ onClose, open }: Props) {
  const {
    recoveryItems,
    isRetrying,
    handleDismissRecoveryItem,
    handleRetryCorruptedItem,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
  } = useDataRecovery()

  return (
    <Dialog onClose={onClose} open={open} fullWidth maxWidth="md">
      <DialogTitle>Corrupted Data Recovery</DialogTitle>
      <DialogContent>
        {recoveryItems.length === 0 ? (
          <Typography color="textSecondary">
            No corrupted data recovery actions are required right now.
          </Typography>
        ) : (
          <Stack spacing={2}>
            {recoveryItems.map(item => (
              <Paper key={item.id} variant="outlined" sx={{ p: 2 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{
                  alignItems: { sm: 'center' }
                }}>
                  <Stack spacing={0.5} sx={{
                    flexGrow: 1
                  }}>
                    <Typography variant="subtitle1" sx={{
                      fontWeight: 500
                    }}>
                      Corrupted item requires manual recovery
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Item ID: {item.itemId}
                    </Typography>
                    <Typography variant="caption" color="textSecondary">
                      {item.reason || 'Auto-recovery exhausted all options.'}
                    </Typography>
                  </Stack>

                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="outlined"
                      color="primary"
                      size="small"
                      disabled={isRetrying !== null}
                      startIcon={isRetrying === item.itemId ? <CircularProgress size={14} color="inherit" /> : undefined}
                      onClick={() => {
                        void handleRetryCorruptedItem(item.itemId)
                      }}
                    >
                      Retry
                    </Button>
                    <Button
                      variant="contained"
                      color="warning"
                      size="small"
                      disabled={isRetrying !== null}
                      startIcon={isRetrying === item.itemId ? <CircularProgress size={14} color="inherit" /> : undefined}
                      onClick={() => {
                        void handleForceOverwriteCorruptedItem(item.itemId)
                      }}
                    >
                      Overwrite with local cache
                    </Button>
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      disabled={isRetrying !== null}
                      onClick={() => {
                        void handleForceDeleteCorruptedItem(item.itemId)
                      }}
                    >
                      Force delete server item
                    </Button>
                    <Button
                      variant="text"
                      color="inherit"
                      size="small"
                      disabled={isRetrying !== null}
                      onClick={() => {
                        void handleDismissRecoveryItem(item.id)
                      }}
                    >
                      Dismiss
                    </Button>
                  </Stack>
                </Stack>
              </Paper>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button fullWidth variant="outlined" onClick={onClose}>
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default DataRecoveryDialog
