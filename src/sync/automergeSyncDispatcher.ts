import { useSyncStore } from '../state/syncStore'
import { useAuthStore } from '../state/authStore'
import { listAutomergeDocumentIds, resolvePendingAutomergeHandles } from './automergeDocStore'
import {
  startAutomergeKnownItemIdsOrchestrator,
  stopAutomergeKnownItemIdsOrchestrator,
} from './automergeKnownItemIdsOrchestrator'
import {
  registerKnownAutomergeItemIds,
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

function normalizeItemIds(itemIds?: string[]): string[] {
  const source = Array.isArray(itemIds)
    ? itemIds
    : listAutomergeDocumentIds()

  const deduped = new Set<string>()
  for (const itemId of source) {
    if (typeof itemId !== 'string' || itemId.length === 0) {
      continue
    }

    deduped.add(itemId)
  }

  return Array.from(deduped)
}

async function runSync(account: string, itemIds?: string[]): Promise<string[]> {
  const normalized = normalizeItemIds(itemIds)
  if (normalized.length === 0) {
    return []
  }

  useSyncStore.getState().setIsSyncing(true)
  try {
    resolvePendingAutomergeHandles()

    await withTimeout(
      syncKnownAutomergeItemIds(normalized),
      SYNC_QUEUE_TIMEOUT_MS,
      `[automergeSyncDispatcher] Sync timed out after ${SYNC_QUEUE_TIMEOUT_MS}ms`,
    )

    return normalized
  } finally {
    useSyncStore.getState().setIsSyncing(false)
  }
}

export async function pullRemoteMessagesNow(account?: string | null, itemIds?: string[]): Promise<string[]> {
  const activeAccount = account || getActiveAccount()
  if (!activeAccount) {
    return []
  }

  return runSync(activeAccount, itemIds)
}

let syncQueue: Promise<unknown> = Promise.resolve()

export function requestAutomergeSync(itemIds?: string[] | string): void {
  const account = getActiveAccount()
  const normalized = normalizeItemIds(typeof itemIds === 'string' ? [itemIds] : itemIds)

  if (!account) {
    if (normalized.length > 0) {
      registerKnownAutomergeItemIds(normalized)
    }

    if (SHOULD_THROW_SYNC_ERRORS) {
      throw new Error('Sync dispatcher is not active')
    }
    return
  }

  syncQueue = syncQueue
    .then(() => runSync(account, normalized))
    .catch(error => {
      console.error('Background sync failed:', error)
    })
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (!account) {
    return
  }

  setVaultNetworkAccount(account)
  startAutomergeKnownItemIdsOrchestrator(account)

  void syncKnownAutomergeItemIds()
}

export function stopAutomergeSyncDispatcher(): void {
  stopAutomergeKnownItemIdsOrchestrator()
  setVaultNetworkAccount(null)
  useSyncStore.getState().setIsSyncing(false)
}
