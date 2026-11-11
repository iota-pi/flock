import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'

import { requestAppUpdate } from '../app/appUpdate'
import { useAppStore } from '../state/store'

/** What updating costs: the reload forgets the vault keys (see appUpdate.ts) */
export function describeAppUpdate(loggedIn: boolean): string {
  return loggedIn
    ? 'A new version of Flock is ready. Updating will lock Flock.'
    : 'A new version of Flock is ready.'
}

export default function AppUpdateSnackbar() {
  const open = useAppStore(state => state.appUpdateReady && !state.appUpdateDismissed)
  const loggedIn = useAppStore(state => state.loggedIn)
  const dismissAppUpdate = useAppStore(state => state.dismissAppUpdate)

  return (
    <Snackbar
      open={open}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ mb: { xs: 8, sm: 3 } }}
    >
      <Alert
        severity="info"
        variant="filled"
        action={
          <>
            <Button
              color="inherit"
              size="small"
              onClick={dismissAppUpdate}
              sx={{ textTransform: 'none' }}
            >
              Not now
            </Button>
            <Button
              color="inherit"
              size="small"
              variant="outlined"
              onClick={requestAppUpdate}
              sx={{ ml: 1, borderColor: 'rgba(255,255,255,0.7)', textTransform: 'none', fontWeight: 600 }}
            >
              Update
            </Button>
          </>
        }
        sx={{ width: '100%', alignItems: 'center' }}
      >
        {describeAppUpdate(loggedIn)}
      </Alert>
    </Snackbar>
  )
}
