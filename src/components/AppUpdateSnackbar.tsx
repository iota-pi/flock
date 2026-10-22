import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'

import { requestAppUpdate } from '../app/appUpdate'
import { useAppStore } from '../state/store'

export default function AppUpdateSnackbar() {
  const open = useAppStore(state => state.appUpdateReady)

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
          <Button
            color="inherit"
            size="small"
            variant="outlined"
            onClick={requestAppUpdate}
            sx={{ ml: 1, borderColor: 'rgba(255,255,255,0.7)', textTransform: 'none', fontWeight: 600 }}
          >
            Reload
          </Button>
        }
        sx={{ width: '100%', alignItems: 'center' }}
      >
        A new version of Flock is ready.
      </Alert>
    </Snackbar>
  )
}
