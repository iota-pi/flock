import * as Sentry from '@sentry/react'
import { ensureItemsBootstrap } from '../api/itemReadService'
import { useSyncStore } from '../state/syncStore'
import {
  startAutomergeSyncDispatcher,
  stopAutomergeSyncDispatcher,
} from './automergeSyncDispatcher'
import { getAutomergeRepo, getVaultNetworkAdapter } from './automergeRepo'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import type { AutomergeIndexDocument } from './automergeDocStore'
import type { DocHandle } from '@automerge/automerge-repo/slim'
import { UnauthorizedError, NetworkTimeoutError } from './SyncTransportService'
import { useAuthStore } from 'src/state/authStore'

let indexHandle: DocHandle<AutomergeIndexDocument> | null = null
const knownItemIds = new Set<string>()
let pendingFetchQueue: string[] = []
const FETCH_CHUNK_SIZE = 10
let processQueueTimeout: number | null = null
let reconnectAttempts = 0
let reconnectTimeout: number | null = null

function processFetchQueue(): void {
  if (pendingFetchQueue.length === 0) {
    if (processQueueTimeout !== null) {
      window.clearTimeout(processQueueTimeout)
      processQueueTimeout = null
    }
    return
  }

  const currentChunk = pendingFetchQueue.splice(0, FETCH_CHUNK_SIZE)
  const repo = getAutomergeRepo(useAuthStore.getState().account)

  for (const id of currentChunk) {
    knownItemIds.add(id)
    repo.find(toAutomergeUrlFromItemId(id))
  }

  processQueueTimeout = window.setTimeout(processFetchQueue, 10)
}

function handleIndexChange(): void {
  if (!indexHandle || !indexHandle.isReady()) return
  const doc = indexHandle.doc()
  if (doc?.itemIds && Array.isArray(doc.itemIds)) {
    const incomingIds = new Set<string>()
    for (const id of doc.itemIds) {
      if (typeof id === 'string') {
        incomingIds.add(id)
      }
    }

    for (const id of incomingIds) {
      if (!knownItemIds.has(id)) {
        pendingFetchQueue.push(id)
      }
    }

    for (const id of knownItemIds) {
      if (!incomingIds.has(id)) {
        knownItemIds.delete(id)
      }
    }

    if (processQueueTimeout === null) {
      processQueueTimeout = window.setTimeout(processFetchQueue, 0)
    }
  }
}


function getErrorMessage(error: unknown): string {
  if (error instanceof UnauthorizedError) {
    return 'Authentication failed. Please log in again.'
  }
  if (error instanceof NetworkTimeoutError) {
    return 'Connection timed out. Please check your internet connection.'
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message
  }

  return 'Failed to initialize local data. Please reload the app.'
}

export async function startSync(account: string): Promise<void> {
  const { clearFatalError, setFatalError, setSyncStatus } = useSyncStore.getState()

  try {
    clearFatalError()
    setSyncStatus('connecting')

    startAutomergeSyncDispatcher(account)

    const repo = getAutomergeRepo(account)
    indexHandle = await repo.find<AutomergeIndexDocument>(toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID))

    if (!indexHandle) return
    await indexHandle.whenReady(['ready', 'unavailable'])

    indexHandle.on('change', handleIndexChange)
    handleIndexChange()

    await ensureItemsBootstrap(account)

    const adapter = getVaultNetworkAdapter(account)
    adapter.on('close', () => {
      setSyncStatus('offline')
      if (reconnectTimeout) {
        window.clearTimeout(reconnectTimeout)
      }
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000)
      reconnectAttempts += 1
      reconnectTimeout = window.setTimeout(() => {
        setSyncStatus('connecting')
        adapter.setAccount(account)
      }, delay)
    })

    adapter.on('peer-candidate', () => {
      reconnectAttempts = 0
      setSyncStatus('syncing')
    })
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
  knownItemIds.clear()
  pendingFetchQueue = []
  if (processQueueTimeout !== null) {
    window.clearTimeout(processQueueTimeout)
    processQueueTimeout = null
  }
  if (reconnectTimeout) {
    window.clearTimeout(reconnectTimeout)
    reconnectTimeout = null
  }
  reconnectAttempts = 0
  stopAutomergeSyncDispatcher()
}

