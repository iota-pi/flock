import { useEffect } from 'react'
import { ensureItemsBootstrap } from '../api/itemReadService'
import { useSyncStore } from '../state/syncStore'
import {
  requestAutomergeSync,
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

      if (!enabled || !account) {
        stopAutomergeSyncDispatcher()
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

          startAutomergeSyncDispatcher(account)
          requestAutomergeSync()
        } catch (error) {
          if (cancelled) {
            return
          }

          stopAutomergeSyncDispatcher()
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