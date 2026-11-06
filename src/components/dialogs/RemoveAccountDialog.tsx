import { useEffect, useState } from 'react'
import type { UnsyncedChanges } from '@vault/client'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import FormControlLabel from '@mui/material/FormControlLabel'
import Typography from '@mui/material/Typography'

import { SyncBridge } from '../../app/vault/syncBridge'
import { createLogger } from '../../utils/logger'

const log = createLogger('RemoveAccountDialog')

type CheckState =
  | { status: 'checking' }
  | { status: 'checked', changes: UnsyncedChanges }
  | { status: 'failed' }

function pluralItems(count: number): string {
  return count === 1 ? '1 item' : `${count} items`
}

function describeUnsynced(check: CheckState): string {
  if (check.status !== 'checked') {
    return "Flock couldn't check whether every change on this device has been synced. "
      + "Any changes that haven't synced will be lost."
  }
  const { pendingItems, quarantinedItems } = check.changes
  const parts: string[] = []
  if (pendingItems > 0) {
    parts.push(`${pluralItems(pendingItems)} on this device ${pendingItems === 1 ? 'has' : 'have'} changes that haven't synced yet`)
  }
  if (quarantinedItems > 0) {
    parts.push(`${pluralItems(quarantinedItems)} can't sync and ${quarantinedItems === 1 ? 'needs' : 'need'} recovery`)
  }
  return `${parts.join(', and ')}. Removing local data will permanently lose those changes.`
}

interface Props {
  open: boolean,
  onCancel: () => void,
  onConfirm: () => void,
  onExport: () => void,
}

/**
 * Confirms signing out and removing this device's data. It never stops the user, but changes that
 * haven't reached the server need an explicit acknowledgement first, since removing them loses them.
 */
function RemoveAccountDialog({ open, onCancel, ...props }: Props) {
  return (
    <Dialog open={open} onClose={onCancel} aria-labelledby="remove-account-title">
      {/* Mounted only while open, so every opening checks again and asks afresh */}
      <RemoveAccountContent onCancel={onCancel} {...props} />
    </Dialog>
  )
}

function RemoveAccountContent({ onCancel, onConfirm, onExport }: Omit<Props, 'open'>) {
  const [check, setCheck] = useState<CheckState>({ status: 'checking' })
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    let cancelled = false
    SyncBridge.getUnsyncedChanges().then(
      changes => {
        if (!cancelled) setCheck({ status: 'checked', changes })
      },
      error => {
        log.warn('Could not count unsynced changes', error)
        if (!cancelled) setCheck({ status: 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const checking = check.status === 'checking'
  const hasUnsynced = check.status === 'failed'
    || (check.status === 'checked' && check.changes.pendingItems + check.changes.quarantinedItems > 0)

  return (
    <>
      <DialogTitle id="remove-account-title">
        Sign out and remove local data?
      </DialogTitle>

      <DialogContent>
        <Typography component="p" gutterBottom>
          Are you sure you want to sign out and remove all local data from this device?
          You will need an active internet connection
          to download your data again the next time you sign in.
        </Typography>
        <Typography gutterBottom>
          It is <strong>highly recommended</strong> to perform this action on shared devices
          or in high-security environments.
          Otherwise, you could simply lock the app.
        </Typography>

        {checking && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 2 }}>
            <CircularProgress size={16} />
            <Typography variant="body2" color="text.secondary">
              Checking for changes that haven&apos;t synced…
            </Typography>
          </Box>
        )}

        {hasUnsynced && (
          <Alert
            severity="error"
            sx={{ mt: 2 }}
            action={(
              <Button color="inherit" size="small" onClick={onExport}>
                Export backup
              </Button>
            )}
          >
            {describeUnsynced(check)}
            {' '}
            To keep them, cancel and reconnect so they can sync, or export a backup first.
          </Alert>
        )}

        {hasUnsynced && (
          <FormControlLabel
            sx={{ mt: 1 }}
            control={(
              <Checkbox
                checked={acknowledged}
                onChange={event => setAcknowledged(event.target.checked)}
                slotProps={{ input: { 'data-cy': 'acknowledge-unsynced-loss' } }}
              />
            )}
            label="I understand these unsynced changes will be lost"
          />
        )}
      </DialogContent>

      <DialogActions sx={{ alignItems: 'stretch' }}>
        <Button
          data-cy="confirm-cancel"
          fullWidth
          onClick={onCancel}
          variant="outlined"
        >
          Cancel
        </Button>

        <Button
          color="error"
          data-cy="confirm-confirm"
          disabled={checking || (hasUnsynced && !acknowledged)}
          fullWidth
          onClick={onConfirm}
          variant="contained"
        >
          {hasUnsynced ? 'Sign out & discard changes' : 'Sign out & remove data'}
        </Button>
      </DialogActions>
    </>
  )
}

export default RemoveAccountDialog
