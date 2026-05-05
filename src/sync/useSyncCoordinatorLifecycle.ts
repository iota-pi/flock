import { useEffect } from 'react'
import { useSyncStore } from '../state/syncStore'
import { SyncBridge } from './SyncBridge'

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      const { clearFatalError } = useSyncStore.getState()
      if (!enabled || !account) {
        if (!account) {
          clearFatalError()
        }
        return
      }

      clearFatalError()
      console.log('[useSyncCoordinatorLifecycle] Initializing sync coordinator for account:', account)
      SyncBridge.initialize(account).catch(error => {
        console.error('[useSyncCoordinatorLifecycle] bootstrap failed', error)
      })
    },
    [account, enabled],
  )
}