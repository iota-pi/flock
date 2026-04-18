import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, CircularProgress, IconButton, Tooltip } from '@mui/material'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import { useUiStore } from '../../state/uiStore'
import { useSyncStore } from '../../state/syncStore'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { ensureItemsBootstrap } from '../../api/itemReadService'
import { getAccountId } from 'src/api/util'

function SyncNowButton() {
  const syncInProgress = useSyncStore(state => state.isSyncing)
  const activeRequests = useUiStore(state => state.activeRequests)
  const storeIsSyncing = syncInProgress || activeRequests > 0
  const isOnline = useOnlineStatus()

  const [isSyncing, setIsSyncing] = useState<boolean>(storeIsSyncing)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (storeIsSyncing) {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
      setIsSyncing(true)
    } else {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null
        setIsSyncing(false)
      }, 100)
    }
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [storeIsSyncing])

  const handleForceSync = useCallback(
    async () => {
      const account = getAccountId()
      try {
        await ensureItemsBootstrap(account, {
          force: true,
          forceFullSync: true,
          forceMetadataRefetch: true,
        })
      } catch (error) {
        console.error('[SyncNowButton] force sync failed', error)
      }
    },
    [],
  )

  const isSyncActive = isSyncing
  const syncStatusIcon = !isOnline
    ? <CloudOffIcon color="warning" />
    : <CloudDoneIcon color="success" />
  const syncTooltip = !isOnline
    ? 'Offline'
    : isSyncActive
      ? 'Syncing'
      : 'Sync Now'

  return (
    <Tooltip title={syncTooltip}>
      <span>
        <IconButton
          onClick={() => {
            void handleForceSync()
          }}
          disabled={!isOnline || isSyncing}
          size="large"
          sx={{ mr: 1 }}
          aria-label="Sync now"
        >
          <Box position="relative" display="inline-flex" alignItems="center" justifyContent="center">
            {isSyncing ? (
              <CircularProgress
                size={24}
                color='info'
              />
            ) : (
              syncStatusIcon
            )}
          </Box>
        </IconButton>
      </span>
    </Tooltip>
  )
}

export default SyncNowButton
