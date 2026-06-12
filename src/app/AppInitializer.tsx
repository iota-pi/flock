import { useEffect } from 'react'
import { loadAccount } from '../api/vault'
import { useAppStore } from '../state/store'
import { useLoggedIn } from '../state/selectors'
import useSyncCoordinatorLifecycle from '../sync/client/useSyncCoordinatorLifecycle'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import { ensurePersistentStorage } from '../utils/storageQuota'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAppStore(state => state.account)
  const setFatalError = useAppStore(state => state.setFatalError)

  useEffect(() => {
    initializeSyncHealthWatchers()
    void ensurePersistentStorage()
    void loadAccount().catch(console.error)
  }, [setFatalError])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}
