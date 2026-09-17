import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'

import { useAppStore } from '../state/store'

interface Props {
  onOpenDetails: () => void
}

export default function QuotaWarningSnackbar({ onOpenDetails }: Props) {
  const isQuotaExceeded = useAppStore(state => state.isQuotaExceeded)

  return (
    <Snackbar
      open={isQuotaExceeded}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ mb: { xs: 8, sm: 3 } }}
    >
      <Alert
        severity="error"
        variant="filled"
        action={
          <Button
            color="inherit"
            size="small"
            variant="outlined"
            onClick={onOpenDetails}
            sx={{ ml: 1, borderColor: 'rgba(255,255,255,0.7)', textTransform: 'none', fontWeight: 600 }}
          >
            View Options
          </Button>
        }
        sx={{ width: '100%', alignItems: 'center' }}
      >
        Storage full: Changes cannot be saved to this device.
      </Alert>
    </Snackbar>
  )
}
