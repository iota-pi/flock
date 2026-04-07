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
import { hasApiAuthToken, handleVaultError  } from './runtime'
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
import { getLastSyncServerTime } from '../sync/syncServerTimeStore'
import {
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
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'

itemsSyncEngine.initialize({
  fetchDelta: async (accountId: string, cacheTime: number | null) => {
    const response = await fetchMany({ cacheTime }).catch(error => {
      handleVaultError(error, 'Failed to fetch items from server')
      return { items: [] as VaultItem[], serverTime: getLastSyncServerTime(accountId) || 0 }
    })

    return {
      items: response.items as VaultItem[],
      serverTime: response.serverTime,
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

export async function fetchItems(): Promise<Item[]> {
  if (!hasApiAuthToken()) {
    return []
  }

  const accountId = getAccountId()
  await initializeAutomergeDocStore(accountId)

  let localItems = getAutomergeItems()

  if (localItems.length === 0) {
    const metadata = await queryClient.fetchQuery({
      queryKey: getQueryKey(trpc.accounts.getMetadata),
      queryFn: fetchMetadata,
      staleTime: 5 * 60 * 1000,
    })

    const mergedItems = await itemsSyncEngine.pull({
      accountId,
      metadata,
    })

    await seedAutomergeItems(mergedItems)
    localItems = getAutomergeItems()
  }

  requestAutomergeSync()

  return sortItems(localItems, DEFAULT_CRITERIA)
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
  const filled = supplyMissingAttributes(materializedItem as Item)
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
