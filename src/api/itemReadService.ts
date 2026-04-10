import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import { getAccountId } from './util'
import { hasApiAuthToken } from './runtime'
import { trpcClient } from './trpcClient'
import { fetchMany } from './vault/client'
import {
  getAutomergeItems,
  getAutomergeMetadata,
  initializeAutomergeDocStore,
  listAutomergeDocumentIds,
  listAutomergeItemIds,
  subscribeAutomergeMetadata,
  upsertAutomergeMetadataSnapshot,
} from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { getVaultNetworkAdapter } from '../sync/automergeRepo'

type FetchItemsOptions = {
  forceFullSync?: boolean
  forceMetadataRefetch?: boolean
}

type EnsureItemsBootstrapOptions = FetchItemsOptions & {
  force?: boolean
}

const bootstrappedAccounts = new Set<string>()
const inFlightBootstrapByAccount = new Map<string, Promise<void>>()

function isMetadataLike(value: unknown): value is AccountMetadata {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasMetadataSnapshot(metadata: AccountMetadata): boolean {
  return Object.keys(metadata || {}).length > 0
}

function normalizeItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const deduped = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const candidate = entry as { item?: unknown }
    if (typeof candidate.item !== 'string' || candidate.item.length === 0) {
      continue
    }

    deduped.add(candidate.item)
  }

  return Array.from(deduped)
}

async function hydrateMetadataIfNeeded(accountId: string, force = false): Promise<void> {
  const localMetadata = getAutomergeMetadata()
  if (!force && hasMetadataSnapshot(localMetadata)) {
    return
  }

  if (!hasApiAuthToken()) {
    return
  }

  const response = await trpcClient.accounts.getMetadata.query({ account: accountId }).catch(() => null)
  if (!response?.success || !isMetadataLike(response.metadata)) {
    return
  }

  await upsertAutomergeMetadataSnapshot(response.metadata, {
    markLocalChange: false,
  })
}

function requestSyncForKnownDocuments(): void {
  const knownDocumentIds = listAutomergeDocumentIds()
  if (knownDocumentIds.length === 0) {
    return
  }

  requestAutomergeSync(knownDocumentIds)
}

export function getCachedMetadata(): AccountMetadata {
  return getAutomergeMetadata()
}

export function subscribeMetadata(listener: () => void): () => void {
  return subscribeAutomergeMetadata(listener)
}

export function clearMetadataCache(): void {
  // Compatibility no-op: metadata is read directly from local Automerge snapshots.
}

export async function ensureMetadataLoaded(
  accountId: string,
  options: { force?: boolean } = {},
): Promise<AccountMetadata> {
  await ensureItemsBootstrap(accountId, {
    force: options.force,
    forceMetadataRefetch: options.force,
  })

  return getAutomergeMetadata()
}

export async function ensureItemsBootstrap(
  accountId: string,
  options: EnsureItemsBootstrapOptions = {},
): Promise<void> {
  await initializeAutomergeDocStore(accountId)

  const shouldForce = !!(options.force || options.forceFullSync || options.forceMetadataRefetch)
  const knownItemIds = listAutomergeItemIds()

  if (!shouldForce && bootstrappedAccounts.has(accountId) && knownItemIds.length > 0) {
    requestSyncForKnownDocuments()
    return
  }

  if (!shouldForce) {
    const inFlight = inFlightBootstrapByAccount.get(accountId)
    if (inFlight) {
      return inFlight
    }
  }

  const bootstrap = (async () => {
    if (hasApiAuthToken()) {
      const response = await fetchMany({ cacheTime: null }).catch(() => ({ items: [] as Array<{ item: string }> }))
      const fetchedItemIds = normalizeItemIds(response.items)
      if (fetchedItemIds.length > 0) {
        getVaultNetworkAdapter().registerKnownItemIds(fetchedItemIds)
        requestAutomergeSync(fetchedItemIds)
      }
    }

    await hydrateMetadataIfNeeded(accountId, options.forceMetadataRefetch === true)

    requestSyncForKnownDocuments()

    if (options.forceMetadataRefetch) {
      requestAutomergeSync()
    }

    bootstrappedAccounts.add(accountId)
  })()

  if (!shouldForce) {
    inFlightBootstrapByAccount.set(accountId, bootstrap)
  }

  await bootstrap.finally(() => {
    if (!shouldForce) {
      inFlightBootstrapByAccount.delete(accountId)
    }
  })
}

export async function fetchItems(options: FetchItemsOptions = {}): Promise<Item[]> {
  const accountId = getAccountId()

  await ensureItemsBootstrap(accountId, {
    force: options.forceFullSync,
    forceFullSync: options.forceFullSync,
    forceMetadataRefetch: options.forceMetadataRefetch,
  })

  return sortItems(getAutomergeItems(), DEFAULT_CRITERIA)
}

export async function fetchMetadata(accountId = getAccountId()): Promise<AccountMetadata> {
  await ensureItemsBootstrap(accountId)
  return getAutomergeMetadata()
}

export function hasItemsInCache(): boolean {
  return getAutomergeItems().length > 0
}
