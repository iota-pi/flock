import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type SubmitEvent } from 'react'
import * as Sentry from '@sentry/react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Checkbox from '@mui/material/Checkbox'
import Container from '@mui/material/Container'
import FormControlLabel from '@mui/material/FormControlLabel'
import LinearProgress from '@mui/material/LinearProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { readStoredMetadata, type DataVersionStatus } from '@vault/client'
import { usePasswordStrength } from '../hooks/usePasswordStrength'
import { deferMigration, MIN_DEVICE_DATA_VERSION, readMigrationHandoff } from './detection'
import {
  beginSync,
  changeToArgon2id,
  describeBlocker,
  finishMigration,
  isMigrationComplete,
  OfflineError,
  reencryptPasswordDerivedData,
  startMigration,
} from './migration'
import { getSyncState, MigrationBridge, subscribeSyncState } from './migrationBridge'

export const POLL_INTERVAL_MS = 5000
/** Idle polls without progress before the remaining blockers are shown */
const POLLS_BEFORE_BLOCKED = 6

type Phase =
  | { kind: 'login' }
  | { kind: 'newPassword' }
  // The password has been changed, but sync didn't start: retrying must not change it again
  | { kind: 'syncNotStarted' }
  | { kind: 'running', status: DataVersionStatus | null }
  | { kind: 'blocked', status: DataVersionStatus }
  | { kind: 'finishing' }

type ReencryptionProgress = { done: number, total: number }

function initialAccount(): string {
  return readMigrationHandoff() ?? readStoredMetadata()?.account ?? ''
}

export default function MigrateApp() {
  const [phase, setPhase] = useState<Phase>({ kind: 'login' })
  const [account, setAccount] = useState(initialAccount)
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [consented, setConsented] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reencryption, setReencryption] = useState<ReencryptionProgress | null>(null)
  // The password the user logged in with, kept only until the new one is set, to tell them apart
  const [currentPassword, setCurrentPassword] = useState('')
  // Re-encryption runs at most once per attempt; anything left is reported as blocked
  const reencryptionStartedRef = useRef(false)
  const reencryptionRunningRef = useRef(false)
  const { score: newPasswordScore, error: newPasswordStrengthError } = usePasswordStrength(newPassword)
  const syncState = useSyncExternalStore(subscribeSyncState, getSyncState)
  const syncStatusRef = useRef(syncState.status)
  useEffect(() => {
    syncStatusRef.current = syncState.status
  }, [syncState.status])

  const finish = useCallback(async () => {
    setPhase({ kind: 'finishing' })
    try {
      await finishMigration(account)
    } catch (err) {
      Sentry.captureException(err)
      setError('Your data is up to date, but something went wrong closing this page. Reload to continue.')
    }
  }, [account])

  const startSync = useCallback(async () => {
    await beginSync(account)
    setPhase({ kind: 'running', status: null })
  }, [account])

  const handleSubmit = useCallback(async (event: SubmitEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const { needsNewPassword } = await startMigration(account, password)
      if (needsNewPassword) {
        setCurrentPassword(password)
        setPassword('')
        setPhase({ kind: 'newPassword' })
        return
      }
      setPassword('')
      await startSync()
    } catch (err) {
      if (!(err instanceof OfflineError)) {
        console.error('[MigrateApp] Failed to start migration', err)
      }
      setError(err instanceof Error ? err.message : 'Login failed.')
    } finally {
      setLoading(false)
    }
  }, [account, password, startSync])

  let newPasswordProblem = ''
  if (newPassword === currentPassword && newPassword) {
    newPasswordProblem = 'Please choose a password you have not used for Flock before'
  } else if (newPasswordStrengthError) {
    newPasswordProblem = newPasswordStrengthError
  } else if (confirmPassword && confirmPassword !== newPassword) {
    newPasswordProblem = 'The passwords do not match'
  }
  // The strength check is asynchronous, and reports a score once it has run
  const canChangePassword = !!newPassword
    && newPasswordScore > 0
    && !newPasswordProblem
    && confirmPassword === newPassword
    && consented

  const handleChangePassword = useCallback(async (event: SubmitEvent) => {
    event.preventDefault()
    if (!canChangePassword) return
    setLoading(true)
    setError('')
    try {
      await changeToArgon2id(account, newPassword)
    } catch (err) {
      console.error('[MigrateApp] Failed to change the password', err)
      setError(err instanceof Error ? err.message : 'Changing your password failed.')
      setLoading(false)
      return
    }
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    try {
      await startSync()
    } catch (err) {
      console.error('[MigrateApp] Failed to start sync after changing the password', err)
      setError(err instanceof Error ? err.message : 'Starting sync failed.')
      setPhase({ kind: 'syncNotStarted' })
    } finally {
      setLoading(false)
    }
  }, [account, canChangePassword, newPassword, startSync])

  const handleRetryStartSync = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      await startSync()
    } catch (err) {
      console.error('[MigrateApp] Failed to start sync', err)
      setError(err instanceof Error ? err.message : 'Starting sync failed.')
    } finally {
      setLoading(false)
    }
  }, [startSync])

  const reencrypt = useCallback(async () => {
    reencryptionStartedRef.current = true
    reencryptionRunningRef.current = true
    setReencryption({ done: 0, total: 0 })
    try {
      const { failed } = await reencryptPasswordDerivedData(account, (done, total) => setReencryption({ done, total }))
      if (failed.length > 0) {
        Sentry.captureMessage('Migration re-encryption failed for some items', { extra: { failed: failed.length } })
      }
    } catch (err) {
      console.warn('[MigrateApp] Re-encryption failed', err)
      Sentry.captureException(err)
    } finally {
      reencryptionRunningRef.current = false
      setReencryption(null)
    }
  }, [account])

  const isRunning = phase.kind === 'running'
  useEffect(() => {
    if (!isRunning) return undefined

    let idlePolls = 0
    let cancelled = false
    const poll = async () => {
      let status: DataVersionStatus
      try {
        status = await MigrationBridge.checkDataVersion()
      } catch (err) {
        console.warn('[MigrateApp] Failed to check the data version', err)
        return
      }
      if (cancelled) return
      if (isMigrationComplete(status)) {
        void finish()
        return
      }
      // Waits until local data is migrated and sync has settled, so a rewrite still in progress
      // isn't reported as blocked
      const settled = status.device >= MIN_DEVICE_DATA_VERSION && syncStatusRef.current === 'idle'
      if (settled && status.blockers.includes('passwordDerivedDataKey') && !reencryptionStartedRef.current) {
        // Every item is local once sync has settled, so all of them get re-encrypted
        void reencrypt()
      }
      idlePolls = settled && !reencryptionRunningRef.current ? idlePolls + 1 : 0
      if (idlePolls >= POLLS_BEFORE_BLOCKED) {
        Sentry.captureMessage('Migration blocked', { extra: { blockers: status.blockers } })
        setPhase({ kind: 'blocked', status })
        return
      }
      setPhase({ kind: 'running', status })
    }

    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [finish, isRunning, reencrypt])

  const handleRetry = useCallback(async () => {
    reencryptionStartedRef.current = false
    setPhase({ kind: 'running', status: null })
    try {
      await MigrationBridge.fullResync()
    } catch (err) {
      console.warn('[MigrateApp] Full resync failed', err)
    }
  }, [])

  const handleContinueAnyway = useCallback(async () => {
    deferMigration(account)
    await finish()
  }, [account, finish])

  // The main app can't log in to an account still on the old key derivation, so deferring then
  // would only bring the user straight back here
  const canContinueAnyway = phase.kind === 'blocked' && !phase.status.blockers.includes('legacyKeyDerivation')

  return (
    <Container maxWidth="sm">
      <Box sx={{ py: 6 }}>
        <Paper sx={{ p: 3 }}>
          <Stack spacing={2}>
            <Typography variant="h5" component="h1">Welcome back!</Typography>

            {phase.kind === 'login' && (
              <form onSubmit={handleSubmit}>
                <Stack spacing={2}>
                  <Typography>
                    Since you last connected to Flock, some behind-the-scenes things have changed about how it stores your data. These changes have been made to improve privacy and security. Log in to update it on this device.
                    You may be asked to choose a new password. This is a once-off process that only takes a minute or two.
                  </Typography>
                  <TextField
                    label="Account ID"
                    value={account}
                    onChange={event => setAccount(event.target.value)}
                    autoComplete="username"
                    required
                  />
                  <TextField
                    label="Password"
                    type="password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    autoComplete="current-password"
                    required
                  />
                  <Button type="submit" variant="contained" disabled={loading || !account || !password}>
                    Update my data
                  </Button>
                </Stack>
              </form>
            )}

            {phase.kind === 'newPassword' && (
              <form onSubmit={handleChangePassword}>
                <Stack spacing={2}>
                  <Typography>
                    Flock now protects your password with stronger encryption. To finish moving to it,
                    please choose a new password that you haven&apos;t used for Flock before.
                  </Typography>
                  <Alert severity="warning">
                    <Typography variant="body2" gutterBottom>
                      Changing your password will:
                    </Typography>
                    <Typography variant="body2" component="ul" sx={{ m: 0, pl: 2 }}>
                      <li>log you out on your other devices, until you log in there with the new password</li>
                      <li>turn off fingerprint or face unlock, which you can turn on again in Settings</li>
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 1 }}>
                      Your data is encrypted with your password, so nobody can reset it for you. If you
                      forget it, your data can&apos;t be recovered. A password manager can remember it for you.
                    </Typography>
                  </Alert>
                  <TextField
                    label="New password"
                    type="password"
                    value={newPassword}
                    onChange={event => setNewPassword(event.target.value)}
                    autoComplete="new-password"
                    error={!!newPasswordProblem}
                    helperText={newPasswordProblem || ' '}
                    required
                  />
                  <TextField
                    label="Confirm new password"
                    type="password"
                    value={confirmPassword}
                    onChange={event => setConfirmPassword(event.target.value)}
                    autoComplete="new-password"
                    required
                  />
                  <FormControlLabel
                    control={<Checkbox checked={consented} onChange={event => setConsented(event.target.checked)} />}
                    label="I understand, and I've saved my new password somewhere safe"
                  />
                  <Button type="submit" variant="contained" disabled={loading || !canChangePassword}>
                    Change password and continue
                  </Button>
                </Stack>
              </form>
            )}

            {phase.kind === 'syncNotStarted' && (
              <>
                <Typography>
                  Your password has been changed. Use your new password from now on.
                  Updating your data couldn&apos;t start, so please try again.
                </Typography>
                <Button variant="contained" onClick={handleRetryStartSync} disabled={loading}>
                  Try again
                </Button>
              </>
            )}

            {(phase.kind === 'running' || phase.kind === 'finishing') && (
              <>
                <Typography>
                  {phase.kind === 'finishing'
                    ? 'Done. Taking you back to Flock…'
                    : 'Updating your data. Keep this page open until it finishes.'}
                </Typography>
                {reencryption && reencryption.total > 0
                  ? (
                    <>
                      <Typography variant="body2" color="text.secondary">
                        Re-encrypting your items ({reencryption.done} of {reencryption.total})
                      </Typography>
                      <LinearProgress variant="determinate" value={(100 * reencryption.done) / reencryption.total} />
                    </>
                  )
                  : <LinearProgress />}
                {phase.kind === 'running' && phase.status && phase.status.blockers.length > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    Still to update: {phase.status.blockers.map(describeBlocker).join(', ')}
                  </Typography>
                )}
                {syncState.warning && <Alert severity="warning">{syncState.warning}</Alert>}
              </>
            )}

            {phase.kind === 'blocked' && (
              <>
                <Alert severity="warning">
                  Some of your data could not be updated: {phase.status.blockers.map(describeBlocker).join(', ')}.
                </Alert>
                <Typography>
                  {canContinueAnyway
                    ? 'You can try again, or continue to Flock now. Items that could not be updated will appear under data recovery in Settings. If this keeps happening, please contact support.'
                    : 'Please try again. If this keeps happening, please contact support.'}
                </Typography>
                <Stack direction="row" spacing={2}>
                  <Button variant="contained" onClick={handleRetry}>Try again</Button>
                  {canContinueAnyway && <Button onClick={handleContinueAnyway}>Continue to Flock</Button>}
                </Stack>
              </>
            )}

            {error && <Alert severity="error">{error}</Alert>}
            {syncState.fatalError && <Alert severity="error">{syncState.fatalError}</Alert>}
          </Stack>
        </Paper>
      </Box>
    </Container>
  )
}
