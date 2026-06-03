import { useEffect } from 'react'
import * as Sentry from '@sentry/react'
import { loadVault } from '../api/vault'
import { useAuthStore } from '../state/authStore'
import { useLoggedIn } from '../state/selectors'
import { useSyncStore } from '../state/syncStore'
import useSyncCoordinatorLifecycle from '../sync/useSyncCoordinatorLifecycle'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import { ensurePersistentStorage } from '../utils/storageQuota'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAuthStore(state => state.account)
  const setFatalError = useSyncStore(state => state.setFatalError)

  useEffect(() => {
    let cancelled = false

    initializeSyncHealthWatchers()
    void ensurePersistentStorage()

    void loadVault().catch(error => {
      if (cancelled) {
        return
      }

      console.error('[AppInitializer] loadVault failed', error)
      Sentry.captureException(error)

      const message = error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Failed to initialize vault session. Please reload the app.'

      setFatalError(message)
    })

    return () => {
      cancelled = true
    }
  }, [setFatalError])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}
