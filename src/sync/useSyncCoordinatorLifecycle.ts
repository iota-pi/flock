import { useEffect } from 'react'
import { ensureItemsBootstrap } from '../api/itemReadService'
import { useSyncStore } from '../state/syncStore'
import { startSyncCoordinator, stopSyncCoordinator } from './syncCoordinator'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return 'Failed to initialize local data. Please reload the app.'
}

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      const { clearFatalError, setFatalError } = useSyncStore.getState()

      if (!enabled || !account) {
        stopSyncCoordinator()
        clearFatalError()
        return
      }

      let cancelled = false

      void (async () => {
        try {
          clearFatalError()
          await ensureItemsBootstrap(account)
          if (cancelled) {
            return
          }

          startSyncCoordinator({ account })
        } catch (error) {
          if (cancelled) {
            return
          }

          stopSyncCoordinator()
          setFatalError(getErrorMessage(error))
        }
      })()

      return () => {
        cancelled = true
        stopSyncCoordinator()
      }
    },
    [account, enabled],
  )
}