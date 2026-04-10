import { useEffect } from 'react'
import { loadVault } from '../api/vault'
import { useAuthStore } from '../state/authStore'
import { useLoggedIn } from '../state/selectors'
import { useSyncStore } from '../state/syncStore'
import { initializeBackgroundSyncPushQueue } from '../sync/backgroundSyncPushQueue'
import useSyncCoordinatorLifecycle from '../sync/useSyncCoordinatorLifecycle'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAuthStore(state => state.account)
  const setFatalError = useSyncStore(state => state.setFatalError)
  const setSyncWarning = useSyncStore(state => state.setSyncWarning)
  const clearSyncWarning = useSyncStore(state => state.clearSyncWarning)

  useEffect(() => {
    void loadVault().catch(error => {
      const message = error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Failed to initialize vault session. Please reload the app.'

      setFatalError(message)
    })
  }, [setFatalError])

  useEffect(() => {
    void initializeBackgroundSyncPushQueue()
      .then(() => {
        clearSyncWarning()
      })
      .catch(() => {
        setSyncWarning('Offline background sync is degraded. If you close the app while offline, queued sync changes may be lost.')
      })
  }, [clearSyncWarning, setSyncWarning])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}