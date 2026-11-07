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
import {
  type DataVersionStatus,
  readStoredMetadata,
  reencryptionWaitStage,
  type ReencryptStage,
  type SyncDiagnostics,
} from '@vault/client'
import { createLogger } from 'src/utils/logger'
import { usePasswordStrength } from '../hooks/usePasswordStrength'
import { deferMigration, MIN_DEVICE_DATA_VERSION, readMigrationHandoff } from './detection'
import {
  beginSync,
  changeToArgon2id,
  describeBlocker,
  finishMigration,
  isMigrationComplete,
  needsReencryption,
  OfflineError,
  reencryptOutdatedItems,
  startMigration,
} from './migration'
import { getSyncState, MigrationBridge, subscribeSyncState } from './migrationBridge'
import { getClientOutdatedWarning, subscribeClientOutdatedWarning } from './clientOutdatedWarning'

const log = createLogger('MigrateApp')

export const POLL_INTERVAL_MS = 5000
/** Idle polls without progress before the remaining blockers are shown */
const POLLS_BEFORE_BLOCKED = 6
/**
 * How long the update may go without progress (a change in the levels, the blockers or the
 * re-encryption) before it's shown as stuck, whatever it's waiting on
 */
export const STALL_TIMEOUT_MS = 5 * 60 * 1000
/** How long re-encryption waits for this tab to lead, and for first start, before giving up */
export const REENCRYPT_WAIT_TIMEOUT_MS = 60 * 1000

/**
 * Why the update stopped: blockers left once everything has run, another tab holding the sync
 * leadership, sync never settling, or the server not answering
 */
type BlockedReason = 'blockers' | 'anotherTab' | 'syncStalled' | 'serverUnreachable'

type Phase =
  | { kind: 'login' }
  | { kind: 'newPassword' }
  // The password has been changed, but sync didn't start: retrying must not change it again
  | { kind: 'syncNotStarted' }
  | { kind: 'running', status: DataVersionStatus | null }
  | { kind: 'blocked', status: DataVersionStatus | null, reason: BlockedReason }
  | { kind: 'finishing' }

type ReencryptionProgress = { done: number, total: number }

function waitFailureReason(stage: ReencryptStage | null): BlockedReason {
  return stage === 'waitingForLeader' ? 'anotherTab' : 'syncStalled'
}

const BLOCKED_MESSAGES: Record<Exclude<BlockedReason, 'blockers'>, string> = {
  anotherTab: 'Flock is open in another tab or window on this device, which is stopping the update. Close it, then try again.',
  syncStalled: 'Your data could not finish syncing with the server, so the update could not continue.',
  serverUnreachable: 'Flock could not reach the server to check on the update.',
}

async function readSyncDiagnostics(): Promise<SyncDiagnostics | null> {
  try {
    return await MigrationBridge.getSyncDiagnostics()
  } catch {
    return null
  }
}

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
  const [loadingMessage, setLoadingMessage] = useState('')
  const [reencryption, setReencryption] = useState<ReencryptionProgress | null>(null)
  // The password the user logged in with, kept only until the new one is set, to tell them apart
  const [currentPassword, setCurrentPassword] = useState('')
  const [reencryptStage, setReencryptStage] = useState<ReencryptStage | null>(null)
  // Re-encryption runs at most once per attempt; anything left is reported as blocked
  const reencryptionStartedRef = useRef(false)
  const reencryptionRunningRef = useRef(false)
  // Cancels the run in flight, so that Try again starts a new one rather than joining a stuck one
  const reencryptionAbortRef = useRef<AbortController | null>(null)
  const reencryptStageRef = useRef<ReencryptStage | null>(null)
  const reencryptionDoneRef = useRef(0)
  // Set when the run gave up waiting, which ends the attempt with that reason
  const reencryptionWaitFailureRef = useRef<BlockedReason | null>(null)
  const { score: newPasswordScore, error: newPasswordStrengthError } = usePasswordStrength(newPassword)
  const syncState = useSyncExternalStore(subscribeSyncState, getSyncState)
  const clientOutdatedWarning = useSyncExternalStore(subscribeClientOutdatedWarning, getClientOutdatedWarning)
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
    setLoadingMessage('Signing in and preparing the update…')
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
        log.error('Failed to start migration', err)
      }
      setError(err instanceof Error ? err.message : 'Login failed.')
    } finally {
      setLoading(false)
      setLoadingMessage('')
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
    setLoadingMessage('Changing your password and preparing the update…')
    setError('')
    try {
      await changeToArgon2id(account, newPassword)
    } catch (err) {
      log.error('Failed to change the password', err)
      setError(err instanceof Error ? err.message : 'Changing your password failed.')
      setLoading(false)
      setLoadingMessage('')
      return
    }
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
    try {
      await startSync()
    } catch (err) {
      log.error('Failed to start sync after changing the password', err)
      setError(err instanceof Error ? err.message : 'Starting sync failed.')
      setPhase({ kind: 'syncNotStarted' })
    } finally {
      setLoading(false)
      setLoadingMessage('')
    }
  }, [account, canChangePassword, newPassword, startSync])

  const handleRetryStartSync = useCallback(async () => {
    setLoading(true)
    setLoadingMessage('Starting your data update…')
    setError('')
    try {
      await startSync()
    } catch (err) {
      log.error('Failed to start sync', err)
      setError(err instanceof Error ? err.message : 'Starting sync failed.')
    } finally {
      setLoading(false)
      setLoadingMessage('')
    }
  }, [startSync])

  const updateReencryptStage = useCallback((stage: ReencryptStage | null) => {
    reencryptStageRef.current = stage
    setReencryptStage(stage)
  }, [])

  const clearReencryption = useCallback(() => {
    reencryptionAbortRef.current = null
    reencryptionRunningRef.current = false
    setReencryption(null)
    updateReencryptStage(null)
  }, [updateReencryptStage])

  /** Stops the run in flight in the worker too, which has changed nothing if it was still waiting */
  const cancelReencryption = useCallback(() => {
    reencryptionAbortRef.current?.abort()
    clearReencryption()
  }, [clearReencryption])

  const reencrypt = useCallback(async (blockers: string[]) => {
    reencryptionStartedRef.current = true
    reencryptionRunningRef.current = true
    reencryptionDoneRef.current = 0
    const controller = new AbortController()
    reencryptionAbortRef.current = controller
    setReencryption({ done: 0, total: 0 })
    try {
      const onProgress = (done: number, total: number) => {
        reencryptionDoneRef.current = done
        setReencryption({ done, total })
      }
      const { failed } = await reencryptOutdatedItems(account, blockers, onProgress, {
        waitTimeoutMs: REENCRYPT_WAIT_TIMEOUT_MS,
        signal: controller.signal,
        onStage: updateReencryptStage,
      })
      if (failed.length > 0) {
        Sentry.captureMessage('Migration re-encryption failed for some items', { extra: { failed: failed.length } })
      }
    } catch (err) {
      if (controller.signal.aborted) return
      const waitStage = reencryptionWaitStage(err)
      if (waitStage) {
        log.warn('Re-encryption gave up waiting', err)
        reencryptionWaitFailureRef.current = waitFailureReason(waitStage)
      } else {
        log.warn('Re-encryption failed', err)
        Sentry.captureException(err)
      }
    } finally {
      // A cancelled run's state went when it was cancelled, and a new run may own it now
      if (reencryptionAbortRef.current === controller) clearReencryption()
    }
  }, [account, clearReencryption, updateReencryptStage])

  const isRunning = phase.kind === 'running'
  useEffect(() => {
    if (!isRunning) return undefined

    let idlePolls = 0
    let cancelled = false
    let lastStatus: DataVersionStatus | null = null
    // Sync status is left out: one that keeps flipping between syncing and failing isn't progress
    let lastProgress = ''
    let lastProgressAt = Date.now()
    const isStalled = () => Date.now() - lastProgressAt >= STALL_TIMEOUT_MS

    const block = (status: DataVersionStatus | null, reason: BlockedReason) => {
      cancelled = true
      const stage = reencryptStageRef.current
      const syncStatus = syncStatusRef.current
      if (reason !== 'blockers') cancelReencryption()
      setPhase({ kind: 'blocked', status, reason })
      void readSyncDiagnostics().then(diagnostics => {
        Sentry.captureMessage('Migration blocked', {
          extra: {
            reason,
            blockers: status?.blockers,
            device: status?.device,
            account: status?.account,
            syncStatus,
            stage,
            diagnostics,
          },
        })
      })
    }

    const poll = async () => {
      let status: DataVersionStatus
      try {
        status = await MigrationBridge.checkDataVersion()
      } catch (err) {
        log.warn('Failed to check the data version', err)
        if (!cancelled && isStalled()) block(lastStatus, 'serverUnreachable')
        return
      }
      if (cancelled) return
      if (isMigrationComplete(status)) {
        void finish()
        return
      }
      lastStatus = status
      const progress = JSON.stringify([
        status.device,
        status.account,
        status.blockers,
        reencryptStageRef.current,
        reencryptionDoneRef.current,
      ])
      if (progress !== lastProgress) {
        lastProgress = progress
        lastProgressAt = Date.now()
      }

      // Waits until local data is migrated and sync has settled, so a rewrite still in progress
      // isn't reported as blocked
      const settled = status.device >= MIN_DEVICE_DATA_VERSION && syncStatusRef.current === 'idle'
      if (settled && needsReencryption(status.blockers) && !reencryptionStartedRef.current) {
        // Every item is local once sync has settled, so all of them get re-encrypted
        void reencrypt(status.blockers)
      }
      const waitFailure = reencryptionWaitFailureRef.current
      if (waitFailure) {
        block(status, waitFailure)
        return
      }
      idlePolls = settled && !reencryptionRunningRef.current ? idlePolls + 1 : 0
      if (idlePolls >= POLLS_BEFORE_BLOCKED) {
        block(status, 'blockers')
        return
      }
      // Whatever it's waiting on, an update that has stopped moving ends rather than polling forever
      if (isStalled()) {
        block(status, waitFailureReason(reencryptStageRef.current))
        return
      }
      setPhase({ kind: 'running', status })
    }

    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [cancelReencryption, finish, isRunning, reencrypt])

  const handleRetry = useCallback(async () => {
    // A stuck run would otherwise be shared by the next one, which would wait on it too
    cancelReencryption()
    reencryptionStartedRef.current = false
    reencryptionWaitFailureRef.current = null
    setPhase({ kind: 'running', status: null })
    try {
      await MigrationBridge.fullResync()
    } catch (err) {
      log.warn('Full resync failed', err)
    }
  }, [cancelReencryption])

  const handleContinueAnyway = useCallback(async () => {
    deferMigration(account)
    await finish()
  }, [account, finish])

  // The main app can't log in to an account still on the old key derivation, so deferring then
  // would only bring the user straight back here
  const canContinueAnyway = phase.kind === 'blocked'
    && phase.status !== null
    && !phase.status.blockers.includes('legacyKeyDerivation')

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
                    Since you last connected to Flock, some behind-the-scenes things have changed about how it stores your data. These changes have been made to improve privacy and security.
                  </Typography>
                  <Typography>
                    Log in again to update it on this device. This is a once-off process that only takes a minute or two.
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
                  {loading && (
                    <Box role="status" aria-live="polite">
                      <LinearProgress sx={{ mb: 1 }} />
                      <Typography variant="body2" color="text.secondary">{loadingMessage}</Typography>
                    </Box>
                  )}
                  <Button type="submit" variant="contained" loading={loading} disabled={!account || !password}>
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
                  {loading && (
                    <Box role="status" aria-live="polite">
                      <LinearProgress sx={{ mb: 1 }} />
                      <Typography variant="body2" color="text.secondary">{loadingMessage}</Typography>
                    </Box>
                  )}
                  <Button type="submit" variant="contained" loading={loading} disabled={!canChangePassword}>
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
                {phase.kind === 'running' && reencryptStage === 'waitingForLeader' && (
                  <Typography variant="body2" color="text.secondary">
                    Waiting for Flock to close in your other tabs or windows…
                  </Typography>
                )}
                {phase.kind === 'running' && reencryptStage === 'waitingForSync' && (
                  <Typography variant="body2" color="text.secondary">
                    Waiting for your data to finish syncing…
                  </Typography>
                )}
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
                  {phase.reason === 'blockers'
                    ? `Some of your data could not be updated: ${(phase.status?.blockers ?? []).map(describeBlocker).join(', ')}.`
                    : BLOCKED_MESSAGES[phase.reason]}
                  {phase.reason !== 'blockers' && phase.status && phase.status.blockers.length > 0 && (
                    ` Still to update: ${phase.status.blockers.map(describeBlocker).join(', ')}.`
                  )}
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
            {clientOutdatedWarning && <Alert severity="warning">{clientOutdatedWarning}</Alert>}
          </Stack>
        </Paper>
      </Box>
    </Container>
  )
}
