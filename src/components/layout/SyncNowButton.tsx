import { useCallback, useEffect, useState } from 'react'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import IconButton from '@mui/material/IconButton'
import Tooltip from '@mui/material/Tooltip'

import { CloudDoneIcon, CloudOffIcon } from '../Icons'
import { useAppStore } from 'src/state/store'
import { useOnlineStatus } from 'src/hooks/useOnlineStatus'
import { SyncBridge } from 'src/sync/client/SyncBridge'


function SyncNowButton() {
  const syncStatus = useAppStore(state => state.syncStatus)
  const activeRequests = useAppStore(state => state.activeRequests)
  const storeIsSyncing = syncStatus === 'syncing' || activeRequests > 0
  const isOnline = useOnlineStatus()

  const [isSyncing, setIsSyncing] = useState<boolean>(storeIsSyncing)
  const [prevStoreSyncing, setPrevStoreSyncing] = useState<boolean>(storeIsSyncing)

  // Derive state immediately during render to prevent synchronous useEffect updates
  if (storeIsSyncing !== prevStoreSyncing) {
    setPrevStoreSyncing(storeIsSyncing)
    if (storeIsSyncing) {
      setIsSyncing(true)
    }
  }

  // Handle the delayed switch to "false" asynchronously
  useEffect(() => {
    if (!storeIsSyncing) {
      const timeoutId = setTimeout(() => {
        setIsSyncing(false)
      }, 100)

      return () => clearTimeout(timeoutId)
    }
  }, [storeIsSyncing])

  const handleForceSync = useCallback(() => {
    void SyncBridge.forceSync()
  }, [])

  const syncStatusIcon = !isOnline ? (
    <CloudOffIcon color="warning" />
  ) : syncStatus === 'degraded' ? (
    <CloudOffIcon color="warning" />
  ) : (
    <CloudDoneIcon color="success" />
  )

  const syncTooltip = !isOnline
    ? 'Offline'
    : syncStatus === 'degraded'
      ? 'Sync Degraded (Storage quota exceeded)'
      : isSyncing
        ? 'Syncing'
        : 'Sync Now'

  return (
    <Tooltip title={syncTooltip}>
      <span>
        <IconButton
          onClick={() => void handleForceSync()}
          disabled={!isOnline || isSyncing}
          size="large"
          sx={{ mr: 1 }}
          aria-label="Sync now"
        >
          <Box
            sx={{
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center"
            }}>
            {(isSyncing
              ? <CircularProgress size={24} color="info" />
              : syncStatusIcon
            )}
          </Box>
        </IconButton>
      </span>
    </Tooltip>
  )
}

export default SyncNowButton