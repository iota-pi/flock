import {
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Typography,
} from '@mui/material'
import { useOfflineRecovery } from '../../hooks/useOfflineRecovery'

interface Props {
  onClose: () => void
  open: boolean
}

function OfflineRecoveryDialog({ onClose, open }: Props) {
  const {
    recoveryItems,
    isRetrying,
    handleDismissRecoveryItem,
    handleRetryCorruptedItem,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
  } = useOfflineRecovery()

  return (
    <Dialog onClose={onClose} open={open} fullWidth maxWidth="md">
      <DialogTitle>Offline Data Recovery</DialogTitle>

      <DialogContent>
        {recoveryItems.length === 0 ? (
          <Typography color="textSecondary">
            No offline recovery actions are required right now.
          </Typography>
        ) : (
          <Stack spacing={2}>
            {recoveryItems.map(item => (
              <Paper key={item.id} variant="outlined" sx={{ p: 2 }}>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                  <Stack flexGrow={1} spacing={0.5}>
                    <Typography variant="subtitle1" fontWeight={500}>
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

export default OfflineRecoveryDialog
