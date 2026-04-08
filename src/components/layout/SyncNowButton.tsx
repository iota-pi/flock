import { useCallback } from 'react'
import { Box, CircularProgress, IconButton, Tooltip } from '@mui/material'
import CloudDoneIcon from '@mui/icons-material/CloudDone'
import CloudOffIcon from '@mui/icons-material/CloudOff'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import { useUiStore } from '../../state/uiStore'
import { useSyncStore } from '../../state/syncStore'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'
import { ensureItemsBootstrap } from '../../api/itemReadService'
import { getAccountId } from 'src/api/util'

function SyncNowButton() {
  const syncInProgress = useSyncStore(state => state.isSyncing)
  const activeRequests = useUiStore(state => state.requests.active)
  const isSyncing = syncInProgress || activeRequests > 0
  const isOnline = useOnlineStatus()

  const handleForceSync = useCallback(
    async () => {
      const account = getAccountId()
      await ensureItemsBootstrap(account, {
        force: true,
        forceFullSync: true,
        forceMetadataRefetch: true,
      })
    },
    [],
  )

  const isQueueActive = isSyncing
  const syncStatusIcon = !isOnline
    ? <CloudOffIcon color="warning" />
    : isQueueActive
      ? <CloudUploadIcon color="info" />
      : <CloudDoneIcon color="success" />
  const syncTooltip = !isOnline
    ? 'Offline'
    : isQueueActive
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
