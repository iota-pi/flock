import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type SubmitEvent } from 'react'
import * as Sentry from '@sentry/react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import LinearProgress from '@mui/material/LinearProgress'
import Paper from '@mui/material/Paper'
import Stack from '@mui/material/Stack'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'
import { readStoredMetadata, type DataVersionStatus } from '@vault/client'
import { deferMigration, MIN_DATA_VERSION, readMigrationHandoff } from './detection'
import {
  describeBlocker,
  finishMigration,
  isMigrationComplete,
  OfflineError,
  startMigration,
} from './migration'
import { getSyncState, MigrationBridge, subscribeSyncState } from './migrationBridge'

export const POLL_INTERVAL_MS = 5000
/** Idle polls without progress before the remaining blockers are shown */
const POLLS_BEFORE_BLOCKED = 6

type Phase =
  | { kind: 'login' }
  | { kind: 'running', status: DataVersionStatus | null }
  | { kind: 'blocked', status: DataVersionStatus }
  | { kind: 'finishing' }

function initialAccount(): string {
  return readMigrationHandoff() ?? readStoredMetadata()?.account ?? ''
}

export default function MigrateApp() {
  const [phase, setPhase] = useState<Phase>({ kind: 'login' })
  const [account, setAccount] = useState(initialAccount)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
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

  const handleSubmit = useCallback(async (event: SubmitEvent) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      await startMigration(account, password)
      setPassword('')
      setPhase({ kind: 'running', status: null })
    } catch (err) {
      if (!(err instanceof OfflineError)) {
        console.error('[MigrateApp] Failed to start migration', err)
      }
      setError(err instanceof Error ? err.message : 'Login failed.')
    } finally {
      setLoading(false)
    }
  }, [account, password])

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
      idlePolls = status.device >= MIN_DATA_VERSION && syncStatusRef.current === 'idle' ? idlePolls + 1 : 0
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
  }, [finish, isRunning])

  const handleRetry = useCallback(async () => {
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
                    This is a once-off process that only takes a minute or two.
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

            {(phase.kind === 'running' || phase.kind === 'finishing') && (
              <>
                <Typography>
                  {phase.kind === 'finishing'
                    ? 'Done. Taking you back to Flock…'
                    : 'Updating your data. Keep this page open until it finishes.'}
                </Typography>
                <LinearProgress />
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
                  You can try again, or continue to Flock now. Items that could not be updated will
                  appear under data recovery in Settings. If this keeps happening, please contact support.
                </Typography>
                <Stack direction="row" spacing={2}>
                  <Button variant="contained" onClick={handleRetry}>Try again</Button>
                  <Button onClick={handleContinueAnyway}>Continue to Flock</Button>
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
