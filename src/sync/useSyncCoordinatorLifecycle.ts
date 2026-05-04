import { useEffect } from 'react'
import { useSyncStore } from '../state/syncStore'
import { ensureItemsBootstrap } from '../api/itemReadService'

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      const { clearFatalError, setSyncStatus } = useSyncStore.getState()
      if (!enabled || !account) {
        if (!account) {
          clearFatalError()
        }
        return
      }

      void (async () => {
        try {
          clearFatalError()
          setSyncStatus('connecting')
          await ensureItemsBootstrap(account)
        } catch (error) {
          console.error('[useSyncCoordinatorLifecycle] bootstrap failed', error)
        }
      })()

      return () => {
        // Nothing to clean up
      }
    },
    [account, enabled],
  )
}