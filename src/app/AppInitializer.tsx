import { useEffect } from 'react'
import { loadVault } from '../api/vault'
import { useAuthStore } from '../state/authStore'
import { useLoggedIn } from '../state/selectors'
import { useSyncStore } from '../state/syncStore'
import useSyncCoordinatorLifecycle from '../sync/useSyncCoordinatorLifecycle'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAuthStore(state => state.account)
  const setFatalError = useSyncStore(state => state.setFatalError)

  useEffect(() => {
    void loadVault().catch(error => {
      const message = error instanceof Error && error.message.trim().length > 0
        ? error.message
        : 'Failed to initialize vault session. Please reload the app.'

      setFatalError(message)
    })
  }, [setFatalError])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}