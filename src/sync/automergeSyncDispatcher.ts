import { useSyncStore } from '../state/syncStore'
import { useAuthStore } from '../state/authStore'
import { listAutomergeDocumentIds, resolvePendingAutomergeHandles } from './automergeDocStore'
import {
  setVaultNetworkAccount,
  syncKnownAutomergeItemIds,
} from './automergeRepo'

const SHOULD_THROW_SYNC_ERRORS = (
  import.meta.env.MODE === 'test'
)
const SYNC_QUEUE_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(message))
    }, timeoutMs)
  })

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  })
}

function getActiveAccount(): string | null {
  return useAuthStore.getState().account || null
}

async function runSync(account: string): Promise<string[]> {
  const knownDocumentIds = listAutomergeDocumentIds()
  if (knownDocumentIds.length === 0) {
    return []
  }

  useSyncStore.getState().setIsSyncing(true)
  try {
    resolvePendingAutomergeHandles()

    await withTimeout(
      syncKnownAutomergeItemIds(undefined, account),
      SYNC_QUEUE_TIMEOUT_MS,
      `[automergeSyncDispatcher] Sync timed out after ${SYNC_QUEUE_TIMEOUT_MS}ms`,
    )

    return knownDocumentIds
  } finally {
    useSyncStore.getState().setIsSyncing(false)
  }
}

export async function pullRemoteMessagesNow(account?: string | null, itemIds?: string[]): Promise<string[]> {
  const activeAccount = account || getActiveAccount()
  if (!activeAccount) {
    return []
  }

  void itemIds

  return runSync(activeAccount)
}

let syncQueue: Promise<unknown> = Promise.resolve()

export function requestAutomergeSync(itemIds?: string[] | string): void {
  const account = getActiveAccount()
  void itemIds

  if (!account) {
    if (SHOULD_THROW_SYNC_ERRORS) {
      throw new Error('Sync dispatcher is not active')
    }
    return
  }

  syncQueue = syncQueue
    .then(() => runSync(account))
    .catch(error => {
      console.error('Background sync failed:', error)
    })
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (!account) {
    return
  }

  setVaultNetworkAccount(account)

  void syncKnownAutomergeItemIds(undefined, account)
}

export function stopAutomergeSyncDispatcher(): void {
  setVaultNetworkAccount(null)
  useSyncStore.getState().setIsSyncing(false)
}
