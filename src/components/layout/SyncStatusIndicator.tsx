import { useCallback, useEffect, useState, type MouseEvent, type ReactElement } from 'react'
import Badge from '@mui/material/Badge'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import IconButton from '@mui/material/IconButton'
import Popover from '@mui/material/Popover'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import type { Theme } from '@mui/material/styles'
import useMediaQuery from '@mui/material/useMediaQuery'

import { useAppStore } from '../../state/store'
import { SyncBridge } from '../../app/vault/syncBridge'
import { createLogger } from '../../utils/logger'
import { CloudDoneIcon, CloudIcon, CloudOffIcon, CloudUploadIcon, SyncProblemIcon } from '../Icons'
import { describeLastSynced, summariseSync, type SyncTone } from './syncSummary'

const log = createLogger('SyncStatusIndicator')

/** How often the "last synced" time is refreshed while the details are open */
const NOW_REFRESH_MS = 30_000

const TONE_ICONS: Record<SyncTone, ReactElement> = {
  synced: <CloudDoneIcon fontSize="small" />,
  unknown: <CloudIcon fontSize="small" />,
  pending: <CloudUploadIcon fontSize="small" />,
  offline: <CloudOffIcon fontSize="small" />,
  warning: <SyncProblemIcon fontSize="small" />,
  error: <SyncProblemIcon fontSize="small" />,
}

/** The current time, kept up to date while `active`. Call the returned function to update it at once. */
function useNow(active: boolean): [number, () => void] {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), NOW_REFRESH_MS)
    return () => clearInterval(timer)
  }, [active])
  return [now, () => setNow(Date.now())]
}

/** The app bar's sync status, with details of what's waiting to sync and when this device last synced */
function SyncStatusIndicator() {
  const syncStatus = useAppStore(state => state.syncStatus)
  const syncProgress = useAppStore(state => state.syncProgress)
  const showLabel = useMediaQuery<Theme>(theme => theme.breakpoints.up('sm'))
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [now, updateNow] = useNow(anchor !== null)

  const summary = summariseSync(syncStatus, syncProgress)
  const icon = TONE_ICONS[summary.tone]
  const pending = syncProgress?.pendingItems ?? 0
  const canSyncNow = syncStatus !== 'offline' && syncStatus !== 'dead'

  const handleSyncNow = useCallback(async () => {
    setSyncing(true)
    try {
      await SyncBridge.flushSync()
    } catch (error) {
      log.error('Sync now failed:', error)
    } finally {
      setSyncing(false)
    }
  }, [])

  const openDetails = (event: MouseEvent<HTMLElement>) => {
    updateNow()
    setAnchor(event.currentTarget)
  }
  const ariaLabel = `Sync status: ${summary.headline}`

  return (
    <Box sx={{ ml: 1, mr: 2, display: 'flex', alignItems: 'center' }}>
      <Tooltip title={summary.headline}>
        {summary.label && showLabel ? (
          <Chip
            icon={icon}
            label={summary.label}
            size="small"
            variant="outlined"
            onClick={openDetails}
            aria-label={ariaLabel}
            aria-haspopup="dialog"
            sx={{
              color: 'inherit',
              borderColor: summary.tone === 'error' || summary.tone === 'warning'
                ? 'warning.light'
                : 'rgba(255, 255, 255, 0.4)',
              '& .MuiChip-icon': { color: 'inherit' },
            }}
          />
        ) : (
          <IconButton
            color="inherit"
            onClick={openDetails}
            aria-label={ariaLabel}
            aria-haspopup="dialog"
            size="small"
          >
            <Badge badgeContent={pending} color="secondary" max={99}>
              {icon}
            </Badge>
          </IconButton>
        )}
      </Tooltip>

      <Popover
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { role: 'dialog', 'aria-label': 'Sync details', sx: { p: 2, maxWidth: 320 } } }}
      >
        <Typography variant="subtitle1">{summary.headline}</Typography>
        {summary.details.map(detail => (
          <Typography key={detail} variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {detail}
          </Typography>
        ))}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
          {describeLastSynced(syncProgress?.lastSyncedAt ?? null, now)}
        </Typography>

        <Box sx={{ mt: 1.5, display: 'flex', justifyContent: 'flex-end' }}>
          {syncStatus === 'dead' ? (
            <Button size="small" onClick={() => window.location.reload()}>
              Reload
            </Button>
          ) : (
            <Button size="small" onClick={handleSyncNow} disabled={!canSyncNow || syncing}>
              {syncing ? 'Syncing…' : 'Sync now'}
            </Button>
          )}
        </Box>
      </Popover>
    </Box>
  )
}

export default SyncStatusIndicator
