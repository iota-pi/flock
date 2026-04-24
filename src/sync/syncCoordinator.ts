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

let indexHandle: DocHandle<AutomergeIndexDocument> | null = null

function handleIndexChange(): void {
  if (!indexHandle || !indexHandle.isReady()) return
  const doc = indexHandle.doc()
  if (doc?.itemIds && Array.isArray(doc.itemIds)) {
    const repo = getAutomergeRepo()
    for (const id of doc.itemIds) {
      if (typeof id === 'string') {
        repo.find(toAutomergeUrlFromItemId(id))
      }
    }
  }
}


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

    const repo = getAutomergeRepo(account)
    indexHandle = await repo.find<AutomergeIndexDocument>(toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID))
    
    if (!indexHandle) return
    await indexHandle.whenReady(['ready', 'unavailable'])

    indexHandle.on('change', handleIndexChange)
    handleIndexChange()
  } catch (error) {
    stopSync()
    console.error('[syncCoordinator] bootstrap failed', error)
    Sentry.captureException(error)
    setFatalError(getErrorMessage(error))
  }
}

export function stopSync(): void {
  if (indexHandle) {
    indexHandle.off('change', handleIndexChange)
    indexHandle = null
  }
  stopAutomergeSyncDispatcher()
}

