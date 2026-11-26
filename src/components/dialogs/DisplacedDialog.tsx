import { useCallback, useState } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import Typography from '@mui/material/Typography'

import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../app/vault/syncBridge'

/**
 * Covers the app while another tab has the account, since only one tab syncs it at a time (see "One
 * active tab" in docs/sync-design.md). It has no close: "Use here" takes the account back, and the
 * other tab shows this in turn.
 */
export default function DisplacedDialog() {
  const displaced = useAppStore(state => state.displaced)
  const account = useAppStore(state => state.account)
  const setDisplaced = useAppStore(state => state.setDisplaced)
  const setMessage = useAppStore(state => state.setMessage)
  const [working, setWorking] = useState(false)

  const handleUseHere = useCallback(async () => {
    if (!account) return
    setWorking(true)
    setDisplaced(false)
    try {
      await SyncBridge.takeOverHere(account)
    } catch (error) {
      setMessage({ severity: 'error', message: (error as Error).message || 'Flock could not be opened here.' })
    } finally {
      setWorking(false)
    }
  }, [account, setDisplaced, setMessage])

  return (
    <Dialog open={displaced} fullScreen aria-labelledby="displaced-title">
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 2,
          height: '100%',
          px: 3,
        }}
      >
        <Typography id="displaced-title" variant="h5" component="h1">
          Flock is open in another tab
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ maxWidth: 420 }}>
          Flock can only be used in one tab at a time. Close this tab, or use Flock here instead.
        </Typography>
        <Button
          variant="contained"
          size="large"
          onClick={() => void handleUseHere()}
          disabled={working}
          startIcon={working ? <CircularProgress size={16} color="inherit" /> : undefined}
        >
          Use here
        </Button>
      </Box>
    </Dialog>
  )
}
