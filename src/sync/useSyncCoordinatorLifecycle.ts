import { useEffect } from 'react'
import * as Sentry from '@sentry/react'
import { ensureItemsBootstrap } from '../api/itemReadService'
import { useSyncStore } from '../state/syncStore'
import {
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'
import { getAutomergeRepo } from './automergeRepo'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import type { AutomergeIndexDocument } from './automergeDocStore'
import type { DocHandle } from '@automerge/automerge-repo/slim'

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
      let indexHandle: DocHandle<AutomergeIndexDocument> | null = null

      const handleIndexChange = () => {
        if (!indexHandle || !indexHandle.isReady()) return
        const doc = indexHandle.doc()
        if (doc?.itemIds && Array.isArray(doc.itemIds)) {
          const repo = getAutomergeRepo(account)
          for (const id of doc.itemIds) {
            if (typeof id === 'string') {
              repo.find(toAutomergeUrlFromItemId(id))
            }
          }
        }
      }

      void (async () => {
        try {
          await ensureItemsBootstrap(account)
          if (cancelled) {
            return
          }

          clearFatalError()
          startAutomergeSyncDispatcher(account)

          const repo = getAutomergeRepo(account)
          indexHandle = await repo.find<AutomergeIndexDocument>(toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID))
          
          if (!indexHandle || cancelled) return
          await indexHandle.whenReady(['ready', 'unavailable'])
          if (cancelled) return

          indexHandle.on('change', handleIndexChange)
          handleIndexChange()

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
        if (indexHandle) {
          indexHandle.off('change', handleIndexChange)
        }
        stopAutomergeSyncDispatcher()
      }
    },
    [account, enabled],
  )
}