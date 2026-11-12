import { useCallback, useState, type ReactNode } from 'react'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import useMediaQuery from '@mui/material/useMediaQuery'
import { useTheme } from '@mui/material/styles'

import { useDataRecovery } from '../../hooks/useDataRecovery'
import { useQuarantinedItems } from '../../state/selectors'
import { deleteItems } from '../../features/items/mutations/itemMutations'
import ConfirmationDialog from './ConfirmationDialog'
import type { ItemId } from '@vault/shared'
import type { ManualRecoveryKind } from '@vault/client'
import { createLogger } from 'src/utils/logger'

const log = createLogger('DataRecoveryDialog')

interface Props {
  onClose: () => void
  open: boolean
}

function getRecoveryTitle(kind: ManualRecoveryKind): string {
  switch (kind) {
    case 'oversized':
      return 'Item edit history too large to sync'
    case 'pullDecryption':
    case 'snapshotDecryption':
      return 'Decryption failure requires manual recovery'
    case 'snapshotFailure':
      return 'Snapshot upload failed'
    case 'pushFailure':
      return 'Changes failed to upload'
    case 'localDecryption':
      return "This device's copy can't be read"
    case 'missingChanges':
      return 'Waiting for changes from another device'
    default:
      return 'Item requires manual recovery'
  }
}

interface RecoveryCardProps {
  children: ReactNode
  description: string
  itemId: string
  itemName?: string
  title: string
}

function RecoveryCard({ children, description, itemId, itemName, title }: RecoveryCardProps) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={0.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
          {title}
        </Typography>
        {itemName && (
          <Typography variant="body2">
            {itemName}
          </Typography>
        )}
        <Typography variant="body2" color="textSecondary" sx={{ wordBreak: 'break-all' }}>
          Item ID: {itemId}
        </Typography>
        <Typography variant="body2" color="textSecondary">
          {description}
        </Typography>
      </Stack>

      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={{
          mt: 2,
          flexWrap: 'wrap',
          alignItems: 'center',
          '& .MuiButton-root': { whiteSpace: 'nowrap' },
        }}
      >
        {children}
      </Stack>
    </Paper>
  )
}

function DataRecoveryDialog({ onClose, open }: Props) {
  const {
    recoveryItems,
    isRetrying,
    handleDismissRecoveryItem,
    handleRetryCorruptedItem,
    handleForceOverwriteCorruptedItem,
    handleForceDeleteCorruptedItem,
    handleRecreateItem,
    handleReplaceFromServer,
  } = useDataRecovery()
  const [itemToReplace, setItemToReplace] = useState<ItemId | null>(null)

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
      log.error('Failed to delete quarantined item:', error)
    } finally {
      setIsDeleting(false)
    }
  }, [quarantinedItemToDelete])

  const theme = useTheme()
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'))

  const totalActionableCount = recoveryItems.length + quarantinedItems.length

  return (
    <>
      <Dialog onClose={onClose} open={open} fullWidth maxWidth="sm" fullScreen={fullScreen}>
        <DialogTitle>Corrupted & Quarantined Data Recovery</DialogTitle>
        <DialogContent>
          {totalActionableCount === 0 ? (
            <Typography color="textSecondary">
              No corrupted or quarantined data recovery actions are required right now.
            </Typography>
          ) : (
            <Stack spacing={2}>
              {recoveryItems.map(item => {
                const isOversized = item.kind === 'oversized'
                const isLocallyUnreadable = item.kind === 'localDecryption'
                const busy = isRetrying !== null
                const spinner = isRetrying === item.itemId ? <CircularProgress size={14} color="inherit" /> : undefined
                const dismiss = (
                  <Button
                    variant="text"
                    color="inherit"
                    size="small"
                    disabled={busy}
                    sx={{ ml: 'auto' }}
                    onClick={() => {
                      void handleDismissRecoveryItem(item.id)
                    }}
                  >
                    Dismiss
                  </Button>
                )

                return (
                  <RecoveryCard
                    key={item.id}
                    title={getRecoveryTitle(item.kind)}
                    itemId={item.itemId}
                    description={item.reason || 'Auto-recovery exhausted all options.'}
                  >
                    {isLocallyUnreadable ? (
                      <>
                        <Button
                          variant="contained"
                          color="primary"
                          size="small"
                          disabled={busy}
                          startIcon={spinner}
                          onClick={() => setItemToReplace(item.itemId)}
                        >
                          Replace from server
                        </Button>
                        {dismiss}
                      </>
                    ) : isOversized ? (
                      <>
                        <Button
                          variant="contained"
                          color="primary"
                          size="small"
                          disabled={busy}
                          startIcon={spinner}
                          onClick={() => {
                            void handleRecreateItem(item.itemId)
                          }}
                        >
                          Recreate Item
                        </Button>
                        {dismiss}
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outlined"
                          color="primary"
                          size="small"
                          disabled={busy}
                          startIcon={spinner}
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
                          disabled={busy}
                          startIcon={spinner}
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
                          disabled={busy}
                          onClick={() => {
                            void handleForceDeleteCorruptedItem(item.itemId)
                          }}
                        >
                          Force delete server item
                        </Button>
                        {dismiss}
                      </>
                    )}
                  </RecoveryCard>
                )
              })}

              {quarantinedItems.map(item => (
                <RecoveryCard
                  key={item.id}
                  title="Quarantined item (Unrecognized format)"
                  itemId={item.id}
                  itemName={item.name && item.name !== 'Corrupt Item' ? item.name : undefined}
                  description="This item cannot be parsed on this device. It may have been created on a newer app version or with unexpected data."
                >
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
                </RecoveryCard>
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

      <ConfirmationDialog
        confirm="Replace from server"
        confirmColour="warning"
        open={itemToReplace !== null}
        onCancel={() => setItemToReplace(null)}
        onConfirm={() => {
          if (itemToReplace) void handleReplaceFromServer(itemToReplace)
          setItemToReplace(null)
        }}
        title="Replace this device's copy?"
      >
        <Typography>
          This device&apos;s copy of the item can&apos;t be decrypted. It will be replaced with the copy on the
          server, and any changes made on this device that haven&apos;t synced yet will be lost.
        </Typography>
      </ConfirmationDialog>
    </>
  )
}

export default DataRecoveryDialog
