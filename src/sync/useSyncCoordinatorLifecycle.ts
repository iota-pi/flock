import { useEffect } from 'react'
import { ensureItemsBootstrap } from '../api/itemReadService'
import { startSyncCoordinator, stopSyncCoordinator } from './syncCoordinator'

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      if (!enabled || !account) {
        stopSyncCoordinator()
        return
      }

      void ensureItemsBootstrap(account).catch(() => undefined)
      startSyncCoordinator({ account })

      return () => {
        stopSyncCoordinator()
      }
    },
    [account, enabled],
  )
}