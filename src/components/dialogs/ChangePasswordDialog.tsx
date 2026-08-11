import { useCallback, useState } from 'react'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import IconButton from '@mui/material/IconButton'

import { changePassword, hasBiometricData } from 'src/api/vault'
import { useAppStore } from 'src/state/store'
import { usePasswordStrength } from 'src/hooks/usePasswordStrength'
import PasswordMeter from '../PasswordMeter'
import { SaveIcon, VisibilityIcon, VisibilityOffIcon } from '../Icons'


interface Props {
  onClose: () => void,
  open: boolean,
  onPasswordChanged?: () => void,
}

export default function ChangePasswordDialog({
  onClose,
  open,
  onPasswordChanged,
}: Props) {
  const account = useAppStore(state => state.account)
  const setMessage = useAppStore(state => state.setMessage)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const [showCurrentPassword, setShowCurrentPassword] = useState(false)
  const [showNewPassword, setShowNewPassword] = useState(false)

  const [loading, setLoading] = useState(false)
  const [errorText, setErrorText] = useState('')

  const biometricsActive = hasBiometricData()

  const { score: passwordScore, error: passwordError } = usePasswordStrength(newPassword)

  const handleClose = useCallback(() => {
    if (loading) return
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setErrorText('')
    onClose()
  }, [loading, onClose])

  const handleDone = useCallback(async () => {
    if (newPassword !== confirmPassword) {
      setErrorText('Passwords do not match')
      return
    }

    if (passwordError) {
      setErrorText(passwordError)
      return
    }

    setLoading(true)
    setErrorText('')
    try {
      await changePassword(account, currentPassword, newPassword)
      let message = 'Password changed successfully.'
      if (biometricsActive) {
        message += ' You can re-enable biometric unlock in Settings.'
      }
      setMessage({
        severity: 'success',
        message,
      })
      handleClose()
      if (onPasswordChanged) {
        onPasswordChanged()
      }
    } catch (err) {
      console.error('[ChangePasswordDialog] changePassword failed', err)
      const msg = err instanceof Error ? err.message : 'Failed to change password. Please verify your current password.'
      setErrorText(msg)
    } finally {
      setLoading(false)
    }
  }, [account, currentPassword, newPassword, confirmPassword, passwordError, handleClose, setMessage, onPasswordChanged, biometricsActive])

  const isValid =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    !passwordError &&
    newPassword === confirmPassword

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>Change Password</DialogTitle>

      <DialogContent>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '8px' }}>
          {biometricsActive && (
            <Alert severity="info">
              Changing your password will disable biometric unlock. You can re-enable biometrics in Settings afterwards.
            </Alert>
          )}

          <TextField
            label="Current Password"
            type={showCurrentPassword ? 'text' : 'password'}
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            disabled={loading}
            fullWidth
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label="toggle password visibility"
                      disabled={loading}
                      edge="end"
                      onClick={() => setShowCurrentPassword(show => !show)}
                    >
                      {showCurrentPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
                'data-cy': 'dialog-current-password-input',
              },
            }}
          />

          <TextField
            label="New Password"
            type={showNewPassword ? 'text' : 'password'}
            value={newPassword}
            onChange={e => {
              setNewPassword(e.target.value)
              setErrorText('')
            }}
            disabled={loading}
            error={!!passwordError && newPassword.length > 0}
            helperText={newPassword.length > 0 ? passwordError : ''}
            fullWidth
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      aria-label="toggle password visibility"
                      onClick={() => setShowNewPassword(show => !show)}
                      edge="end"
                      disabled={loading}
                    >
                      {showNewPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                    </IconButton>
                  </InputAdornment>
                ),
                'data-cy': 'dialog-new-password-input',
              },
            }}
          />

          {newPassword.length > 0 && (
            <PasswordMeter score={passwordScore} />
          )}

          <TextField
            label="Confirm New Password"
            type="password"
            value={confirmPassword}
            onChange={e => {
              setConfirmPassword(e.target.value)
              setErrorText('')
            }}
            disabled={loading}
            error={confirmPassword.length > 0 && newPassword !== confirmPassword}
            helperText={confirmPassword.length > 0 && newPassword !== confirmPassword ? 'Passwords do not match' : ''}
            fullWidth
            slotProps={{
              input: {
                'data-cy': 'dialog-confirm-password-input',
              },
            }}
          />

          {errorText && (
            <div
              data-cy="dialog-error-text"
              role="alert"
              style={{ color: '#d32f2f', fontSize: '0.85rem' }}
            >
              {errorText}
            </div>
          )}
        </div>
      </DialogContent>

      <DialogActions>
        <Button
          onClick={handleClose}
          variant="outlined"
          fullWidth
          disabled={loading}
          data-cy="dialog-cancel"
        >
          Cancel
        </Button>

        <Button
          disabled={!isValid || loading}
          fullWidth
          onClick={handleDone}
          startIcon={<SaveIcon />}
          variant="contained"
          data-cy="dialog-confirm"
        >
          {loading ? 'Changing...' : 'Done'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
