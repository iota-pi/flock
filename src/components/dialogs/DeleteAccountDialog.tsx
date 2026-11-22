import { useRef, useState } from 'react'
import download from 'js-file-download'
import { IncorrectPasswordError } from '@vault/client'
import { formatAccountId } from '@vault/shared'
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
import IconButton from '@mui/material/IconButton'
import InputAdornment from '@mui/material/InputAdornment'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

import {
  deleteServerAccount,
  deleteServerData,
  describeDeletionOutcome,
  startAccountDeletion,
  type DeletionOutcome,
} from '../../app/vault/accountDeletion'
import { removeVaultFromDevice } from '../../app/vault/session'
import useBackupAndRestore, { BACKUP_FILE_NAME } from '../../hooks/useBackupAndRestore'
import { useAppStore } from '../../state/store'
import { createLogger } from '../../utils/logger'
import { VisibilityIcon, VisibilityOffIcon } from '../Icons'

const log = createLogger('DeleteAccountDialog')

type WorkingStep = 'password' | 'items' | 'account' | 'local'

type Phase =
  | { name: 'confirm', error?: string }
  | { name: 'working', step: WorkingStep }
  | { name: 'itemsFailed' }
  | { name: 'accountFailed' }

const STEP_LABELS: Record<WorkingStep, string> = {
  password: 'Checking your password…',
  items: 'Deleting your data from the server…',
  account: 'Deleting your account from the server…',
  local: 'Removing your data from this device…',
}

/**
 * Permanently deletes the account: its data on the server, then its account record, then everything
 * on this device. It asks for the password first, and if a server step fails it says what that leaves
 * behind and lets the user retry or carry on.
 *
 * Settings opens it through the store's `deleteAccountOpen`, and App mounts it, because stopping sync
 * replaces the page with a spinner, which would unmount a dialog mounted there part way through.
 */
function DeleteAccountDialog() {
  const open = useAppStore(state => state.deleteAccountOpen)
  const setUi = useAppStore(state => state.setUi)
  return (
    <Dialog open={open} aria-labelledby="delete-account-title" fullWidth maxWidth="sm">
      {/* Mounted only while open, so every opening starts afresh */}
      {open && <DeleteAccountContent onClose={() => setUi({ deleteAccountOpen: false })} />}
    </Dialog>
  )
}

function DeleteAccountContent({ onClose }: { onClose: () => void }) {
  const account = useAppStore(state => state.account)
  const setMessage = useAppStore(state => state.setMessage)
  const { actions: { handleExport } } = useBackupAndRestore({ setMessage })
  const [phase, setPhase] = useState<Phase>({ name: 'confirm' })
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const authTokenRef = useRef('')
  const outcomeRef = useRef<DeletionOutcome>({ itemsLeft: false, accountLeft: false, localFailed: false })

  async function exportBackup() {
    try {
      download(await handleExport(), BACKUP_FILE_NAME)
    } catch (error) {
      log.error('Export failed', error)
    }
  }

  async function removeFromDevice() {
    setPhase({ name: 'working', step: 'local' })
    try {
      // Once the account record is gone, the server would take any request for it as an expired session
      await removeVaultFromDevice({ accountDeleted: !outcomeRef.current.accountLeft })
    } catch (error) {
      log.error('Failed to remove local data after deleting the account', error)
      outcomeRef.current.localFailed = true
    }
    setMessage(describeDeletionOutcome(outcomeRef.current))
    onClose()
  }

  async function deleteAccountRecord() {
    setPhase({ name: 'working', step: 'account' })
    try {
      await deleteServerAccount(account, authTokenRef.current)
    } catch (error) {
      log.error('Failed to delete the account record', error)
      setPhase({ name: 'accountFailed' })
      return
    }
    await removeFromDevice()
  }

  async function deleteItems() {
    setPhase({ name: 'working', step: 'items' })
    try {
      await deleteServerData(account, authTokenRef.current)
    } catch (error) {
      log.error("Failed to delete the account's data", error)
      setPhase({ name: 'itemsFailed' })
      return
    }
    await deleteAccountRecord()
  }

  async function start() {
    setPhase({ name: 'working', step: 'password' })
    try {
      authTokenRef.current = await startAccountDeletion(account, password)
    } catch (error) {
      log.warn('Could not start deleting the account', error)
      setPhase({
        name: 'confirm',
        error: error instanceof IncorrectPasswordError
          ? 'Incorrect password. Nothing has been deleted.'
          : "Flock couldn't check your password. Check your internet connection and try again. Nothing has been "
            + 'deleted.',
      })
      return
    }
    setPassword('')
    await deleteItems()
  }

  if (phase.name === 'working') {
    return (
      <>
        <DialogTitle id="delete-account-title">Deleting your account</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 2 }}>
            <CircularProgress size={24} />
            <Typography data-cy="delete-account-progress">{STEP_LABELS[phase.step]}</Typography>
          </Box>
          <Typography variant="body2" color="text.secondary">
            Keep Flock open until this finishes.
          </Typography>
        </DialogContent>
      </>
    )
  }

  if (phase.name === 'itemsFailed') {
    return (
      <>
        <DialogTitle id="delete-account-title">Some data couldn&apos;t be deleted</DialogTitle>
        <DialogContent>
          <Alert severity="error" sx={{ mb: 2 }}>
            Flock couldn&apos;t delete all of your data from the server. Check your internet connection and try
            again.
          </Alert>
          <Typography gutterBottom>
            If you continue anyway, your account will be deleted and whatever data is left will stay on the
            server, encrypted. Nobody can read it without your password, but once your account is gone it
            can&apos;t be deleted.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ alignItems: 'stretch' }}>
          <Button
            color="error"
            data-cy="delete-account-continue"
            fullWidth
            onClick={() => {
              outcomeRef.current.itemsLeft = true
              void deleteAccountRecord()
            }}
            variant="outlined"
          >
            Continue anyway
          </Button>
          <Button data-cy="delete-account-retry" fullWidth onClick={() => void deleteItems()} variant="contained">
            Retry
          </Button>
        </DialogActions>
      </>
    )
  }

  if (phase.name === 'accountFailed') {
    return (
      <>
        <DialogTitle id="delete-account-title">Your account couldn&apos;t be deleted</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Your data has been deleted from the server, but Flock couldn&apos;t delete your account itself.
            Check your internet connection and try again.
          </Alert>
          <Typography gutterBottom>
            If you continue anyway, Flock will remove your account from this device. The account will be
            left on the server, empty, and can no longer be signed into.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ alignItems: 'stretch' }}>
          <Button
            color="error"
            data-cy="delete-account-continue"
            fullWidth
            onClick={() => {
              outcomeRef.current.accountLeft = true
              void removeFromDevice()
            }}
            variant="outlined"
          >
            Continue anyway
          </Button>
          <Button data-cy="delete-account-retry" fullWidth onClick={() => void deleteAccountRecord()} variant="contained">
            Retry
          </Button>
        </DialogActions>
      </>
    )
  }

  const canDelete = acknowledged && password.length > 0

  return (
    <>
      <DialogTitle id="delete-account-title">Delete your account?</DialogTitle>

      <DialogContent>
        <Alert severity="error" sx={{ mb: 2 }}>
          This permanently deletes your account and everything in it. It can&apos;t be undone.
        </Alert>

        <Typography gutterBottom>
          Deleting account <strong>{formatAccountId(account)}</strong> will:
        </Typography>
        <Box component="ul" sx={{ mt: 0, pl: 3 }}>
          <li><Typography>delete all of your people, groups, notes and prayer history from the server</Typography></li>
          <li><Typography>stop your prayer reminders</Typography></li>
          <li><Typography>sign out every device, and remove your data from this one</Typography></li>
          <li><Typography>make your account ID and password unusable: you can&apos;t sign in again</Typography></li>
        </Box>
        <Typography gutterBottom>
          Other devices you&apos;ve signed in on keep their copy of your data until you remove it from them.
        </Typography>

        <Alert
          severity="info"
          sx={{ my: 2 }}
          action={(
            <Button color="inherit" size="small" onClick={() => void exportBackup()}>
              Export
            </Button>
          )}
        >
          To keep a copy of your data, export a backup first.
        </Alert>

        <TextField
          autoComplete="current-password"
          error={!!phase.error}
          fullWidth
          helperText={phase.error}
          label="Password"
          onChange={event => {
            setPassword(event.target.value)
            if (phase.error) setPhase({ name: 'confirm' })
          }}
          sx={{ mt: 1 }}
          type={showPassword ? 'text' : 'password'}
          value={password}
          slotProps={{
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label="toggle password visibility"
                    edge="end"
                    onClick={() => setShowPassword(show => !show)}
                  >
                    {showPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                  </IconButton>
                </InputAdornment>
              ),
            },
            htmlInput: { 'data-cy': 'delete-account-password' },
          }}
        />

        <FormControlLabel
          sx={{ mt: 1 }}
          control={(
            <Checkbox
              checked={acknowledged}
              onChange={event => setAcknowledged(event.target.checked)}
              slotProps={{ input: { 'data-cy': 'delete-account-acknowledge' } }}
            />
          )}
          label="I understand that my account and all of its data will be permanently deleted"
        />
      </DialogContent>

      <DialogActions sx={{ alignItems: 'stretch' }}>
        <Button data-cy="delete-account-cancel" fullWidth onClick={onClose} variant="outlined">
          Cancel
        </Button>
        <Button
          color="error"
          data-cy="delete-account-confirm"
          disabled={!canDelete}
          fullWidth
          onClick={() => void start()}
          variant="contained"
        >
          Delete account
        </Button>
      </DialogActions>
    </>
  )
}

export default DeleteAccountDialog
