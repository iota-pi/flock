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

export interface Props {
  onClose: () => void
  open: boolean
}

function OfflineRecoveryDialog({ onClose, open }: Props) {
  const {
    deadLetterItems,
    isRetrying,
    handleRetryDeadLetterMutation,
    handleDiscardDeadLetterMutation,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
  } = useOfflineRecovery()

  return (
    <Dialog onClose={onClose} open={open} fullWidth maxWidth="md">
      <DialogTitle>Offline Data Recovery</DialogTitle>

      <DialogContent>
        {deadLetterItems.length === 0 ? (
          <Typography color="textSecondary">
            No offline recovery actions are required right now.
          </Typography>
        ) : (
          <Stack spacing={2}>
            {deadLetterItems.map(item => (
              <Paper key={item.id} variant="outlined" sx={{ p: 2 }}>
                {item.mutationType === 'items.manualRecovery'
                  ? (
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                      <Stack flexGrow={1} spacing={0.5}>
                        <Typography variant="subtitle1" fontWeight={500}>
                          Corrupted item requires manual recovery
                        </Typography>
                        <Typography variant="body2" color="textSecondary">
                          Item ID: {String((item.payload as { itemId?: string })?.itemId || 'Unknown')}
                        </Typography>
                        <Typography variant="caption" color="textSecondary">
                          {item.errorReason || 'Auto-recovery exhausted all options.'}
                        </Typography>
                      </Stack>

                      <Stack direction="row" spacing={1}>
                        <Button
                          variant="contained"
                          color="warning"
                          size="small"
                          disabled={isRetrying !== null}
                          startIcon={isRetrying === (item.payload as { itemId?: string })?.itemId ? <CircularProgress size={14} color="inherit" /> : undefined}
                          onClick={() => {
                            const itemId = (item.payload as { itemId?: string })?.itemId
                            if (itemId) {
                              void handleForceOverwriteCorruptedItem(itemId)
                            }
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
                            const itemId = (item.payload as { itemId?: string })?.itemId
                            if (itemId) {
                              void handleForceDeleteCorruptedItem(itemId)
                            }
                          }}
                        >
                          Force delete server item
                        </Button>
                      </Stack>
                    </Stack>
                  )
                  : (
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
                  <Stack flexGrow={1} spacing={0.5}>
                    <Typography variant="subtitle1" fontWeight={500}>
                      {item.mutationType}
                    </Typography>
                    <Typography variant="body2" color="textSecondary">
                      Last error status: {item.lastErrorStatus ?? 'Unknown'}
                    </Typography>
                    <Typography variant="caption" color="textSecondary">
                      Last conflict at: {item.lastConflictAt ? new Date(item.lastConflictAt).toLocaleString() : 'N/A'}
                    </Typography>
                  </Stack>

                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={isRetrying !== null}
                      startIcon={isRetrying === item.id ? <CircularProgress size={14} color="inherit" /> : undefined}
                      onClick={() => {
                        void handleRetryDeadLetterMutation(item.id)
                      }}
                    >
                      Retry
                    </Button>
                    <Button
                      variant="outlined"
                      color="warning"
                      size="small"
                      disabled={isRetrying !== null}
                      onClick={() => {
                        void handleDiscardDeadLetterMutation(item.id)
                      }}
                    >
                      Discard
                    </Button>
                  </Stack>
                </Stack>
                  )}
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
