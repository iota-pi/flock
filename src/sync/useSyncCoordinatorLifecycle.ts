import { useEffect } from 'react'
import { useSyncStore } from '../state/syncStore'
import { stopAutomergeSyncDispatcher } from './automergeSyncDispatcher'
import { startSync } from './syncCoordinator'
import { getAutomergeRepo } from './automergeRepo'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import type { AutomergeIndexDocument } from './automergeDocStore'
import type { DocHandle } from '@automerge/automerge-repo/slim'

export default function useSyncCoordinatorLifecycle(
  account: string | null | undefined,
  enabled: boolean,
): void {
  useEffect(
    () => {
      const { clearFatalError } = useSyncStore.getState()
      stopAutomergeSyncDispatcher()

      if (!enabled || !account) {
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
        await startSync(account)
        if (cancelled) return

        const repo = getAutomergeRepo(account)
        indexHandle = await repo.find<AutomergeIndexDocument>(toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID))
        
        if (!indexHandle || cancelled) return
        await indexHandle.whenReady(['ready', 'unavailable'])
        if (cancelled) return

        indexHandle.on('change', handleIndexChange)
        handleIndexChange()
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