import { useSyncStore } from '../state/syncStore'
import { listAutomergeDocumentIds } from './automergeDocStore'
import {
  getVaultNetworkAdapter,
  setVaultNetworkAccount,
} from './automergeRepo'

const SHOULD_THROW_SYNC_ERRORS = (
  import.meta.env.MODE === 'test'
)

function getActiveAccount(): string | null {
  return useSyncStore.getState().activeAccount
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

async function runSync(itemIds?: string[]): Promise<string[]> {
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

export async function pullRemoteMessagesNow(itemIds?: string[]): Promise<string[]> {
  if (!getActiveAccount()) {
    return []
  }

  return runSync(itemIds)
}

export function requestAutomergeSync(itemIds?: string[]): void {
  if (!getActiveAccount()) {
    const normalized = normalizeItemIds(itemIds)
    if (normalized.length > 0) {
      getVaultNetworkAdapter().registerKnownItemIds(normalized)
    }

    if (SHOULD_THROW_SYNC_ERRORS) {
      throw new Error('Sync dispatcher is not active')
    }
    return
  }

  void runSync(itemIds)
}

export function startAutomergeSyncDispatcher(account: string): void {
  if (!account) {
    return
  }

  const { activeAccount, setActiveAccount } = useSyncStore.getState()

  if (activeAccount !== account) {
    setActiveAccount(account)
    setVaultNetworkAccount(account)
  }

  const adapter = getVaultNetworkAdapter()
  adapter.syncItemIds()
}

export function stopAutomergeSyncDispatcher(): void {
  useSyncStore.getState().setActiveAccount(null)
  setVaultNetworkAccount(null)
  useSyncStore.getState().setIsSyncing(false)
}
