import { useEffect } from 'react'
import { loadAccount } from '../api/vault'
import { useAppStore } from '../state/store'
import { useLoggedIn } from '../state/selectors'
import useSyncCoordinatorLifecycle from '../sync/client/useSyncCoordinatorLifecycle'
import { initializeSyncHealthWatchers } from '../api/syncHealthCoordinator'
import { ensurePersistentStorage } from '../utils/storageQuota'
import { getTrackedFetch } from 'src/api/trackedFetch'
import { initTrpcClient } from 'src/api/trpcClient'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAppStore(state => state.account)
  const setFatalError = useAppStore(state => state.setFatalError)

  useEffect(() => {
    const trackedFetch = getTrackedFetch(
      useAppStore.getState().startRequest,
      useAppStore.getState().finishRequest,
    )
    initTrpcClient(trackedFetch)
    initializeSyncHealthWatchers()
    void ensurePersistentStorage()
    void loadAccount().catch(console.error)
  }, [setFatalError])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}
