import { useCallback, useState } from 'react'
import Alert from '@mui/material/Alert'
import AlertTitle from '@mui/material/AlertTitle'

import { useAppStore } from '../state/store'

const NOTICE_DISMISSED_KEY = 'flock_storage_notice_dismissed'

const INSTALL_HINT = 'Install Flock to keep it safe: in Safari, tap Share and then Add to Home Screen; '
  + 'in other browsers, choose Install from the browser menu.'

type Level = 'info' | 'warning'

function isInstalled() {
  const standaloneMedia = typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches
  return standaloneMedia || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function readDismissed() {
  try {
    return localStorage.getItem(NOTICE_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Warns when the browser may evict this device's data (Safari clears storage for sites that aren't
 * installed after about a week without use), which would lose unsynced changes and offline unlock.
 * Dismissing the general notice is remembered, but unsynced changes bring it back as a warning.
 */
export default function StoragePersistenceNotice() {
  const isStoragePersisted = useAppStore(state => state.isStoragePersisted)
  const pendingItems = useAppStore(state => state.syncProgress?.pendingItems ?? 0)
  const [dismissedLevel, setDismissedLevel] = useState<Level | null>(() => (readDismissed() ? 'info' : null))

  const level: Level = pendingItems > 0 ? 'warning' : 'info'

  const handleDismiss = useCallback(() => {
    setDismissedLevel(level)
    if (level === 'info') {
      try {
        localStorage.setItem(NOTICE_DISMISSED_KEY, 'true')
      } catch {
        // The notice stays dismissed until the page reloads
      }
    }
  }, [level])

  if (isStoragePersisted !== false || isInstalled()) return null
  if (dismissedLevel === 'warning' || dismissedLevel === level) return null

  return (
    <Alert severity={level} onClose={handleDismiss} sx={{ m: 2, mb: 0 }}>
      {level === 'warning' ? (
        <>
          <AlertTitle>Unsynced changes could be lost</AlertTitle>
          This browser may clear Flock&apos;s data if you don&apos;t open it for a while, and some changes
          on this device haven&apos;t synced yet. {INSTALL_HINT}
        </>
      ) : (
        <>
          This browser may clear Flock&apos;s data on this device if you don&apos;t open it for a while,
          and you would need to be online to sign in again. {INSTALL_HINT}
        </>
      )}
    </Alert>
  )
}
