import { useEffect } from 'react'
import { useAppStore } from '../../state/store'
import { SyncBridge } from './SyncBridge'

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
      SyncBridge.initialize(account).catch(error => {
        console.error('[useSyncCoordinatorLifecycle] bootstrap failed', error)
      })

      return () => void SyncBridge.shutdown().catch(error => {
        console.error('[useSyncCoordinatorLifecycle] shutdown failed', error)
      })
    },
    [account, enabled],
  )
}