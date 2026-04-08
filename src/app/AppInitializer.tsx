import { useEffect } from 'react'
import { loadVault } from '../api/vault'
import { useAuthStore } from '../state/authStore'
import { useLoggedIn } from '../state/selectors'
import useSyncCoordinatorLifecycle from '../sync/useSyncCoordinatorLifecycle'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAuthStore(state => state.account)

  useEffect(() => {
    void loadVault()
  }, [])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}