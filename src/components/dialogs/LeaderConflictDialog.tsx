import { useState, useCallback } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import CircularProgress from '@mui/material/CircularProgress'
import Dialog from '@mui/material/Dialog'
import DialogActions from '@mui/material/DialogActions'
import DialogContent from '@mui/material/DialogContent'
import DialogTitle from '@mui/material/DialogTitle'
import Typography from '@mui/material/Typography'

import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../sync/client/SyncBridge'

export default function LeaderConflictDialog() {
  const isLeaderConflict = useAppStore(state => state.isLeaderConflict)
  const [claiming, setClaiming] = useState(false)

  const handleClaim = useCallback(async () => {
    setClaiming(true)
    try {
      await SyncBridge.claimLeader()
    } catch (err) {
      console.error('[LeaderConflictDialog] Failed to claim sync leadership:', err)
    } finally {
      setClaiming(false)
    }
  }, [])

  return (
    <Dialog
      open={isLeaderConflict}
      maxWidth="xs"
      fullWidth
      aria-labelledby="leader-conflict-dialog-title"
    >
      <DialogTitle id="leader-conflict-dialog-title">
        Flock is syncing in another tab
      </DialogTitle>

      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2 }}>
          Syncing is paused in this tab to prevent data conflicts.
        </Alert>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Flock is currently active in another open tab on this device. To ensure your changes are safely preserved without race conditions, only one tab can sync at a time.
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Click <strong>Sync in this tab</strong> to resume syncing here, or close this tab to continue where you were.
        </Typography>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button
          variant="contained"
          color="primary"
          fullWidth
          onClick={handleClaim}
          disabled={claiming}
          data-cy="claim-leader-button"
        >
          {claiming ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={16} color="inherit" />
              <span>Claiming sync...</span>
            </Box>
          ) : (
            'Sync in this tab'
          )}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
