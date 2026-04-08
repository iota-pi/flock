import {
  fetchMany,
  getMetadata,
  type VaultItem,
} from './vault/client'
import * as vault from './vault'
import {
  Item,
  supplyMissingAttributes,
} from '../state/items'
import { AccountMetadata } from '../state/metadata'
import { getApiAuthToken, hasApiAuthToken, handleVaultError  } from './runtime'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import { queryClient } from './queryClient'
import { getAccountId } from './util'
import {
  decryptItemsInWorker,
  type WorkerDecryptedItem,
} from '../workers/decryptionWorkerManager'
import { sharedDecryptionCache } from './vault/DecryptionCache'
import { getEnvelopeCacheKey } from './vault/decryptionCacheKey'
import { decryptVaultEnvelope } from './vault/decryptVaultEnvelope'
import { clearLastSyncServerTime, getLastSyncServerTime } from '../sync/syncServerTimeStore'
import {
  clearManualRecoveryForItems,
  initializeSyncHealthWatchers,
  reportDecryptionFailure,
} from './syncHealthCoordinator'
import { parseVaultEnvelope } from './vault/envelopeParser'
import { enqueueCompactionCandidate } from './vault/maintenanceCoordinator'
import { itemsSyncEngine } from './vault/syncEngine'
import migrateItems from '../state/migrations'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from './trpc'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  seedAutomergeItems,
} from '../sync/automergeDocStore'
import { ITEM_TYPES } from '../shared/itemTypes'

const METADATA_QUERY_STALE_TIME_MS = 15 * 60 * 1000

export const metadataQueryOptions = {
  staleTime: METADATA_QUERY_STALE_TIME_MS,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const

const bootstrapPromiseByScope = new Map<string, Promise<void>>()
const completedBootstrapScopes = new Set<string>()

type FetchItemsOptions = {
  forceFullSync?: boolean
  forceMetadataRefetch?: boolean
}

type EnsureItemsBootstrapOptions = FetchItemsOptions & {
  force?: boolean
}

function getBootstrapScopeKey(accountId: string): string {
  return `${accountId}:${getApiAuthToken()}`
}

itemsSyncEngine.initialize({
  fetchDelta: async (accountId: string, cacheTime: number | null) => {
    const response = await fetchMany({ cacheTime }).catch(error => {
      handleVaultError(error, 'Failed to fetch items from server')
      return { items: [] as VaultItem[], serverTime: getLastSyncServerTime(accountId) || 0, success: false }
    })
    const wasSuccessful = 'success' in response ? response.success !== false : true

    return {
      items: response.items as VaultItem[],
      serverTime: response.serverTime,
      success: wasSuccessful,
    }
  },
  decryptItems: decryptVaultItems,
  migrateItems,
})

type DecryptionResult =
  | { ok: true; item: Item }
  | { ok: false; itemId?: string; error: unknown }

function collectSuccessfulDecryptions(
  source: 'worker' | 'main-thread',
  results: DecryptionResult[],
): Item[] {
  const successful: Item[] = []
  for (const result of results) {
    if (result.ok) {
      successful.push(result.item)
      continue
    }

    reportDecryptionFailure({
      source,
      itemId: result.itemId,
      error: result.error,
    })
  }

  if (successful.length > 0) {
    void clearManualRecoveryForItems(successful.map(item => item.id)).catch(() => undefined)
  }

  return successful
}

// Fetch and decrypt all items - TanStack Query handles caching
export async function decryptVaultItems(items: VaultItem[]): Promise<Item[]> {
  initializeSyncHealthWatchers()

  const accountId = getAccountId()
  await sharedDecryptionCache.load(accountId)

  const fromCache: Item[] = []
  const toDecrypt: VaultItem[] = []
  let cacheMutated = false

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.metadata?.deleted) {
      sharedDecryptionCache.delete(item.item)
      cacheMutated = true
      continue
    }

    const envelope = parseVaultEnvelope(item)
    if (!envelope) {
      reportDecryptionFailure({
        source: 'main-thread',
        itemId: item.item,
        error: new Error(`Missing payload for item ${item.item ?? index}`),
      })
      continue
    }

    const cacheKey = getEnvelopeCacheKey(envelope)
    const cached = sharedDecryptionCache.get(item.item)
    if (cached && cached.cacheKey === cacheKey) {
      fromCache.push(cached.item)
      continue
    }

    toDecrypt.push(item)
  }

  if (toDecrypt.length === 0) {
    if (cacheMutated) {
      sharedDecryptionCache.schedulePersist(accountId)
    }
    return fromCache
  }

  const workerDecrypted = await decryptWithWorker(accountId, toDecrypt)
  if (cacheMutated) {
    sharedDecryptionCache.schedulePersist(accountId)
  }
  return [...fromCache, ...workerDecrypted]
}

async function decryptWithWorker(accountId: string, items: VaultItem[]): Promise<Item[]> {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') {
    return decryptWithoutWorker(accountId, vault, items)
  }

  const key = vault.getVaultKey()
  const decrypted = await decryptItemsInWorker({ key, items }).catch(error => {
    reportDecryptionFailure({
      source: 'worker',
      error,
    })
    return []
  })

  const sourcesById = new Map(items.map(item => [item.item, item]))
  let cacheMutated = false

  const results = decrypted.map((workerItem: WorkerDecryptedItem) => {
    const source = sourcesById.get(workerItem.id)
    if (!source) {
      return {
        ok: false,
        itemId: workerItem.id,
        error: new Error(`Worker returned unknown item id: ${workerItem.id}`),
      } satisfies DecryptionResult
    }

    try {
      const automergeBinary = workerItem.automergeBinary
      if (automergeBinary instanceof Uint8Array) {
        enqueueCompactionCandidate({ source, automergeBinary })
      }

      const { automergeBinary: _automergeBinary, ...materialized } = workerItem
      const hydrated = hydrateAndCacheItem(
        accountId,
        source,
        materialized as Partial<Item>,
        automergeBinary,
      )

      if (hydrated.cacheUpdated) {
        cacheMutated = true
      }

      return {
        ok: true,
        item: hydrated.item,
      } satisfies DecryptionResult
    } catch (error) {
      return {
        ok: false,
        itemId: source.item,
        error,
      } satisfies DecryptionResult
    }
  })

  if (cacheMutated) {
    sharedDecryptionCache.schedulePersist(accountId)
  }

  return collectSuccessfulDecryptions('worker', results)
}

async function decryptWithoutWorker(
  accountId: string,
  vaultModule: typeof vault,
  items: VaultItem[],
): Promise<Item[]> {
  let cacheMutated = false
  const decryptedResults = await Promise.allSettled(
    items.map(async source => {
      const envelope = parseVaultEnvelope(source)
      if (!envelope) {
        throw new Error(`Missing payload for item ${source.item}`)
      }

      const decrypted = await decryptVaultEnvelope<Item>({
        envelope,
        key: vaultModule.getVaultKey(),
        decryptLegacyEnvelope: vaultModule.decryptObject,
      })

      const hydrated = hydrateAndCacheItem(
        accountId,
        source,
        decrypted.materialized as Partial<Item>,
        decrypted.automergeBinary,
      )

      if (hydrated.cacheUpdated) {
        cacheMutated = true
      }

      return {
        ok: true,
        item: hydrated.item,
      } satisfies DecryptionResult
    }),
  )

  const results = decryptedResults.map(result => (
    result.status === 'fulfilled'
      ? result.value
      : {
        ok: false,
        error: result.reason,
      } satisfies DecryptionResult
  ))

  if (cacheMutated) {
    sharedDecryptionCache.schedulePersist(accountId)
  }

  return collectSuccessfulDecryptions('main-thread', results)
}

export async function fetchItems(options: FetchItemsOptions = {}): Promise<Item[]> {
  if (!hasApiAuthToken()) {
    return []
  }

  const accountId = getAccountId()
  await initializeAutomergeDocStore(accountId)
  if (options.forceFullSync) {
    clearLastSyncServerTime(accountId)
  }

  const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)
  if (options.forceMetadataRefetch) {
    queryClient.removeQueries({ queryKey: metadataQueryKey })
  }
  const cachedMetadata = queryClient.getQueryData<AccountMetadata>(metadataQueryKey) || {}
  const metadata = await queryClient.fetchQuery({
    queryKey: metadataQueryKey,
    queryFn: fetchMetadata,
    ...metadataQueryOptions,
  }).catch(error => {
    handleVaultError(error as Error, 'Failed to fetch metadata; continuing with cached metadata')
    return cachedMetadata
  })

  const mergedItems = await itemsSyncEngine.pull({
    accountId,
    metadata,
  })

  if (mergedItems.length > 0) {
    await seedAutomergeItems(mergedItems)
  }

  const localItems = getAutomergeItems()
  const visibleItems = localItems.length > 0 ? localItems : mergedItems

  return sortItems(visibleItems, DEFAULT_CRITERIA)
}

export function ensureItemsBootstrap(accountId: string, options: EnsureItemsBootstrapOptions = {}): Promise<void> {
  const scopeKey = getBootstrapScopeKey(accountId)

  if (!options.force && completedBootstrapScopes.has(scopeKey)) {
    return Promise.resolve()
  }

  const inFlight = bootstrapPromiseByScope.get(scopeKey)
  if (inFlight) {
    return inFlight
  }

  const bootstrap = fetchItems(options)
    .then(() => {
      completedBootstrapScopes.add(scopeKey)
    })
    .then(() => undefined)
    .finally(() => {
      bootstrapPromiseByScope.delete(scopeKey)
    })

  bootstrapPromiseByScope.set(scopeKey, bootstrap)
  return bootstrap
}

// Fetch and decrypt metadata
export async function fetchMetadata(): Promise<AccountMetadata> {
  const result = await getMetadata()

  const envelope = parseVaultEnvelope(result)
  if (envelope) {
    const decrypted = await decryptVaultEnvelope<AccountMetadata>({
      envelope,
      key: vault.getVaultKey(),
      decryptLegacyEnvelope: vault.decryptObject,
    })

    if (decrypted.automergeBinary) {
      sharedDecryptionCache.setMetadataBinary(decrypted.automergeBinary)
    }

    return decrypted.materialized
  }

  return (result || {}) as AccountMetadata
}

function hydrateAndCacheItem(
  accountId: string,
  source: VaultItem,
  materializedItem: Partial<Item>,
  automergeBinary?: Uint8Array,
): { item: Item; cacheUpdated: boolean } {
  const workerType = (materializedItem as { type?: unknown }).type
  const metadataType = source.metadata?.type
  const resolvedType = ITEM_TYPES.includes(workerType as Item['type'])
    ? workerType
    : (ITEM_TYPES.includes(metadataType as Item['type']) ? metadataType : undefined)
  const normalized = {
    ...materializedItem,
    id: typeof materializedItem.id === 'string' ? materializedItem.id : source.item,
    type: resolvedType,
  } as Partial<Item>
  const filled = supplyMissingAttributes(normalized as Item)
  const envelope = parseVaultEnvelope(source)

  if (!envelope) {
    return { item: filled, cacheUpdated: false }
  }

  sharedDecryptionCache.set(source.item, {
    cacheKey: getEnvelopeCacheKey(envelope),
    item: filled,
    automergeBinary: automergeBinary instanceof Uint8Array ? automergeBinary : undefined,
  })

  return { item: filled, cacheUpdated: true }
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  queryClient.clear()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(getQueryKey(trpc.items.fetchMany)) !== undefined
}
