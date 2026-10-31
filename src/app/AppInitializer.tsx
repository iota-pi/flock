import { useEffect } from 'react'
import { loadAccount } from './vault/session'
import { useAppStore } from '../state/store'
import { useLoggedIn } from '../state/selectors'
import useSyncCoordinatorLifecycle from './vault/useSyncCoordinatorLifecycle'
import useAccountLevelCheck from './vault/useAccountLevelCheck'
import { prefetchSyncWorker } from './vault/prefetchSyncWorker'
import { failCypressTestOnRequestError, isCypress } from './vault/cypress'
import { ensurePersistentStorage, getTrackedFetch, initVaultTrpcClient } from '@vault/client'
import { initTrpcClient } from 'src/api/trpcClient'
import { useNavigate } from 'react-router'
import { refreshPushSubscription, syncReminderTimezone } from '../utils/pushNotifications'
import { useAutoClearPrayerNotifications } from '../hooks/useAutoClearPrayerNotifications'

export default function AppInitializer() {
  const loggedIn = useLoggedIn()
  const account = useAppStore(state => state.account)
  const setFatalError = useAppStore(state => state.setFatalError)
  const navigate = useNavigate()

  useEffect(() => {
    const trackedFetch = getTrackedFetch(
      useAppStore.getState().startRequest,
      useAppStore.getState().finishRequest,
      isCypress ? failCypressTestOnRequestError : undefined,
    )
    initTrpcClient(trackedFetch)
    initVaultTrpcClient(trackedFetch)
    void ensurePersistentStorage()
    void loadAccount().catch(console.error)
  }, [setFatalError])

  useEffect(() => {
    if (!loggedIn) {
      prefetchSyncWorker()
    }
  }, [loggedIn])

  useEffect(() => {
    if (loggedIn && account) {
      void syncReminderTimezone(account).catch(console.error)
      void refreshPushSubscription(account).catch(console.error)
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
  useAccountLevelCheck(account, loggedIn)
  useAutoClearPrayerNotifications()

  return null
}
