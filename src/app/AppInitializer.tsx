import { useEffect } from 'react'
import { loadAccount } from '../api/vault'
import { useAuthStore } from '../state/authStore'
import { useLoggedIn } from '../state/selectors'
import { useSyncStore } from '../state/syncStore'
import useSyncCoordinatorLifecycle from '../sync/client/useSyncCoordinatorLifecycle'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import { ensurePersistentStorage } from '../utils/storageQuota'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAuthStore(state => state.account)
  const setFatalError = useSyncStore(state => state.setFatalError)

  useEffect(() => {
    initializeSyncHealthWatchers()
    void ensurePersistentStorage()
    void loadAccount().catch(console.error)
  }, [setFatalError])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}
