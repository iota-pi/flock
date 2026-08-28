import { useEffect } from 'react'
import { loadAccount } from '../api/vault'
import { useAppStore } from '../state/store'
import { useLoggedIn } from '../state/selectors'
import useSyncCoordinatorLifecycle from '../sync/client/useSyncCoordinatorLifecycle'
import { ensurePersistentStorage } from '../utils/storageQuota'
import { getTrackedFetch } from 'src/api/trackedFetch'
import { initTrpcClient } from 'src/api/trpcClient'
import { useNavigate } from 'react-router'
import { syncReminderTimezone } from '../utils/pushNotifications'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAppStore(state => state.account)
  const setFatalError = useAppStore(state => state.setFatalError)
  const navigate = useNavigate()

  useEffect(() => {
    const trackedFetch = getTrackedFetch(
      useAppStore.getState().startRequest,
      useAppStore.getState().finishRequest,
    )
    initTrpcClient(trackedFetch)
    void ensurePersistentStorage()
    void loadAccount().catch(console.error)
  }, [setFatalError])

  useEffect(() => {
    if (loggedIn && account) {
      void syncReminderTimezone(account).catch(console.error)
    }
  }, [loggedIn, account])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'NOTIFICATION_CLICK_NAVIGATE' && typeof event.data?.url === 'string') {
        navigate(event.data.url)
      }
    }

    navigator.serviceWorker.addEventListener('message', handleMessage)
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleMessage)
    }
  }, [navigate])

  useSyncCoordinatorLifecycle(account, loggedIn)

  return null
}
