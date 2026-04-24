import { useEffect } from 'react'
import { useSyncStore } from '../state/syncStore'
import { startSync, stopSync } from './syncCoordinator'

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      const { clearFatalError } = useSyncStore.getState()
      stopSync()

      if (!enabled || !account) {
        if (!account) {
          clearFatalError()
        }
        return
      }

      void (async () => {
        await startSync(account)
      })()

      return () => {
        stopSync()
      }
    },
    [account, enabled],
  )
}