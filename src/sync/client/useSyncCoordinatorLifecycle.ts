import { useEffect } from 'react'
import { useAppStore } from '../../state/store'
import { SyncBridge } from './SyncBridge'
import { resumePendingReencryption } from '../../api/vault/reencrypt'
import { attemptSessionRecovery } from '../../api/vault/sessionRecovery'

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      const { clearFatalError } = useAppStore.getState()
      if (!enabled || !account) {
        if (!account) {
          clearFatalError()
        }
        return
      }

      clearFatalError()
      SyncBridge.initialize(account)
        .then(() => {
          void resumePendingReencryption(account)
        })
        .catch(error => {
          console.error('[useSyncCoordinatorLifecycle] bootstrap failed', error)
        })

      const handleOnline = async () => {
        const recovered = await attemptSessionRecovery(account)
        if (recovered) {
          useAppStore.getState().clearSyncWarning()
          SyncBridge.forceSync().catch(console.error)
        }
      }

      window.addEventListener('online', handleOnline)

      return () => {
        window.removeEventListener('online', handleOnline)
        void SyncBridge.shutdown().catch(error => {
          console.error('[useSyncCoordinatorLifecycle] shutdown failed', error)
        })
      }
    },
    [account, enabled],
  )
}