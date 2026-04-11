import { useSyncStore } from '../state/syncStore'
import { useAuthStore } from '../state/authStore'
import { listAutomergeDocumentIds } from './automergeDocStore'
import {
  getVaultNetworkAdapter,
  setVaultNetworkAccount,
} from './automergeRepo'

const SHOULD_THROW_SYNC_ERRORS = (
  import.meta.env.MODE === 'test'
)

function getActiveAccount(): string | null {
  return useAuthStore.getState().account || null
}

function normalizeItemIds(itemIds?: string[]): string[] {
  const source = Array.isArray(itemIds) && itemIds.length > 0
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

  const adapter = getVaultNetworkAdapter()

  useSyncStore.getState().setIsSyncing(true)
  try {
    adapter.syncItemIds(normalized)

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

export function requestAutomergeSync(itemIds?: string[] | string): void {
  const account = getActiveAccount()
  const normalized = normalizeItemIds(typeof itemIds === 'string' ? [itemIds] : itemIds)

  if (!account) {
    if (normalized.length > 0) {
      getVaultNetworkAdapter().registerKnownItemIds(normalized)
    }

    if (SHOULD_THROW_SYNC_ERRORS) {
      throw new Error('Sync dispatcher is not active')
    }
    return
  }

  void runSync(account, normalized)
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (!account) {
    return
  }

  setVaultNetworkAccount(account)

  const adapter = getVaultNetworkAdapter()
  adapter.syncItemIds()
}

export function stopAutomergeSyncDispatcher(): void {
  setVaultNetworkAccount(null)
  useSyncStore.getState().setIsSyncing(false)
}
