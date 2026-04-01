import { useCallback } from 'react'
import { Box, CircularProgress, IconButton, Tooltip } from '@mui/material'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import { useUiStore } from '../../state/uiStore'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { processOfflineQueue } from '../../api/offlineQueue'
import { trpc } from '../../api/trpc'

function SyncNowButton() {
  const trpcUtils = trpc.useUtils()
  const isSyncing = useUiStore(state => state.isSyncing || state.requests.active > 0)
  const offlineQueueLength = useUiStore(state => state.offlineQueueLength)
  const isOnline = useOnlineStatus()

  const handleForceSync = useCallback(async () => {
    await processOfflineQueue()
    await trpcUtils.items.fetchMany.invalidate()
    await trpcUtils.accounts.getMetadata.invalidate()
  }, [trpcUtils])

  const isQueueActive = isSyncing || offlineQueueLength > 0
  const syncStatusIcon = !isOnline
    ? <CloudOffIcon color="warning" />
    : isQueueActive
      ? <CloudUploadIcon color="info" />
      : <CloudDoneIcon color="success" />
  const syncTooltip = !isOnline
    ? 'Offline'
    : isQueueActive
      ? `Syncing (${offlineQueueLength} queued)`
      : 'Synced'

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
            {syncStatusIcon}
            {isSyncing && (
              <CircularProgress
                size={22}
                thickness={5}
                sx={{ position: 'absolute' }}
              />
            )}
          </Box>
        </IconButton>
      </span>
    </Tooltip>
  )
}

export default SyncNowButton
