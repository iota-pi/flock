import { useCallback, useState } from 'react'
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
import { useQuarantinedItems } from '../../state/selectors'
import { deleteItems } from '../../features/items/mutations/itemMutations'
import ConfirmationDialog from './ConfirmationDialog'
import type { ItemId } from 'src/shared/schemas/items'


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

  const quarantinedItems = useQuarantinedItems()
  const [quarantinedItemToDelete, setQuarantinedItemToDelete] = useState<ItemId | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleConfirmDeleteQuarantined = useCallback(async () => {
    if (!quarantinedItemToDelete) return
    setIsDeleting(true)
    try {
      await deleteItems(quarantinedItemToDelete)
      setQuarantinedItemToDelete(null)
    } catch (error) {
      console.error('Failed to delete quarantined item:', error)
    } finally {
      setIsDeleting(false)
    }
  }, [quarantinedItemToDelete])

  const totalActionableCount = recoveryItems.length + quarantinedItems.length

  return (
    <>
      <Dialog onClose={onClose} open={open} fullWidth maxWidth="md">
        <DialogTitle>Corrupted & Quarantined Data Recovery</DialogTitle>
        <DialogContent>
          {totalActionableCount === 0 ? (
            <Typography color="textSecondary">
              No corrupted or quarantined data recovery actions are required right now.
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
                        Decryption failure requires manual recovery
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

              {quarantinedItems.map(item => (
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
                        Quarantined item (Unrecognized format)
                      </Typography>
                      <Typography variant="body2" color="textSecondary">
                        Item ID: {item.id} {item.name && item.name !== 'Corrupt Item' ? `— ${item.name}` : ''}
                      </Typography>
                      <Typography variant="caption" color="textSecondary">
                        This item cannot be parsed on this device. It may have been created on a newer app version or with unexpected data.
                      </Typography>
                    </Stack>

                    <Stack direction="row" spacing={1}>
                      <Button
                        variant="outlined"
                        color="error"
                        size="small"
                        disabled={isDeleting}
                        onClick={() => {
                          setQuarantinedItemToDelete(item.id)
                        }}
                      >
                        Delete Globally
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

      <ConfirmationDialog
        confirm="Delete Globally"
        confirmColour="error"
        open={quarantinedItemToDelete !== null}
        onCancel={() => setQuarantinedItemToDelete(null)}
        onConfirm={handleConfirmDeleteQuarantined}
        title="Delete Quarantined Item Globally?"
      >
        <Typography sx={{ mb: 2 }}>
          Warning: This item failed schema validation locally, but may be valid on other devices or newer app versions.
        </Typography>
        <Typography color="error.main">
          Deleting it here will permanently soft-delete it across <strong>ALL</strong> your synced devices. This action cannot be undone.
        </Typography>
      </ConfirmationDialog>
    </>
  )
}

export default DataRecoveryDialog
