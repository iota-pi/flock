import { useEffect } from 'react'
import * as Sentry from '@sentry/react'
import { ensureItemsBootstrap } from '../api/itemReadService'
import { useSyncStore } from '../state/syncStore'
import {
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'

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
      stopAutomergeSyncDispatcher()

      if (!enabled || !account) {
        // Clear only when fully logged out so initialization errors are not masked.
        if (!account) {
          clearFatalError()
        }
        return
      }

      let cancelled = false

      void (async () => {
        try {
          await ensureItemsBootstrap(account)
          if (cancelled) {
            return
          }

          clearFatalError()
          startAutomergeSyncDispatcher(account)
        } catch (error) {
          if (cancelled) {
            return
          }

          stopAutomergeSyncDispatcher()
          console.error('[useSyncCoordinatorLifecycle] bootstrap failed', error)
          Sentry.captureException(error)
          setFatalError(getErrorMessage(error))
        }
      })()

      return () => {
        cancelled = true
        stopAutomergeSyncDispatcher()
      }
    },
    [account, enabled],
  )
}