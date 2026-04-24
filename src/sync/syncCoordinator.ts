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

export async function startSync(account: string): Promise<void> {
  const { clearFatalError, setFatalError } = useSyncStore.getState()

  try {
    await ensureItemsBootstrap(account)
    clearFatalError()
    startAutomergeSyncDispatcher(account)
  } catch (error) {
    stopAutomergeSyncDispatcher()
    console.error('[syncCoordinator] bootstrap failed', error)
    Sentry.captureException(error)
    setFatalError(getErrorMessage(error))
  }
}
