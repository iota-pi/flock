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
import { hasApiAuthToken } from './runtime'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import {
  queryClient,
  queryKeys,
} from './queryClient'
import { handleVaultError } from './runtime'
import migrateItems from '../state/migrations'
import { getAccountId } from './util'
import * as Automerge from '@automerge/automerge'
import { getCachedMetadataAutomergeBinary } from '../sync/automergeBinaryCache'
import {
  decryptItemsInWorker,
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

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.metadata?.deleted) {
      sharedDecryptionCache.delete(item.item)
      sharedDecryptionCache.schedulePersist(accountId)
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
    return fromCache
  }

  const workerDecrypted = await decryptWithWorker(accountId, toDecrypt)
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

  const results = decrypted.map(item => {
      const id = (item as { id?: unknown }).id
      if (typeof id !== 'string') {
        return {
          ok: false,
          error: new Error('Worker returned decrypted item without id'),
        } satisfies DecryptionResult
      }

      const workerItem = item as { automergeBinary?: unknown } & Record<string, unknown>
      const source = sourcesById.get(id)
      if (!source) {
        return {
          ok: false,
          itemId: id,
          error: new Error(`Worker returned unknown item id: ${id}`),
        } satisfies DecryptionResult
      }

      const automergeBinary = workerItem.automergeBinary
      if (automergeBinary instanceof Uint8Array) {
        enqueueCompactionCandidate({ source, automergeBinary })
      }

      const { automergeBinary: _automergeBinary, ...materialized } = workerItem
      const filled = supplyMissingAttributes(materialized as unknown as Item)
      const envelope = parseVaultEnvelope(source)

      if (envelope) {
        sharedDecryptionCache.set(source.item, {
          cacheKey: getEnvelopeCacheKey(envelope),
          item: filled,
          automergeBinary: automergeBinary instanceof Uint8Array ? automergeBinary : undefined,
        })
        sharedDecryptionCache.schedulePersist(accountId)
      }

      return {
        ok: true,
        item: filled,
      } satisfies DecryptionResult
    })

  return collectSuccessfulDecryptions('worker', results)
}

async function decryptWithoutWorker(
  accountId: string,
  vaultModule: typeof vault,
  items: VaultItem[],
): Promise<Item[]> {
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

      const filled = supplyMissingAttributes(decrypted.materialized)
      sharedDecryptionCache.set(source.item, {
        cacheKey: getEnvelopeCacheKey(envelope),
        item: filled,
        automergeBinary: decrypted.automergeBinary,
      })
      sharedDecryptionCache.schedulePersist(accountId)

      return {
        ok: true,
        item: filled,
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

  return collectSuccessfulDecryptions('main-thread', results)
}

export async function fetchItems(): Promise<Item[]> {
  if (!hasApiAuthToken()) {
    // If API isn't ready to use (no auth token), we can't fetch.
    // Return empty array to satisfy the query temporarily.
    // The real fetch will happen once loadVault completes and triggers a refetch.
    return []
  }

  const accountId = getAccountId()

  const mergedItems = await itemsSyncEngine.pull({
    accountId,
    fetchDelta: async cacheTime => {
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
  })

  // Run migrations
  try {
    const metadata = await queryClient.fetchQuery({
      queryKey: queryKeys.metadata,
      queryFn: fetchMetadata,
      staleTime: 5 * 60 * 1000,
    })
    await migrateItems(mergedItems, metadata)
  } catch (err) {
    console.error('Migration check failed during fetchItems', err)
  }

  return sortItems(mergedItems, DEFAULT_CRITERIA)
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

    const metadata = decrypted.materialized
    const binary = decrypted.automergeBinary || Automerge.save(Automerge.from(metadata as Record<string, unknown>))
    sharedDecryptionCache.setMetadataBinary(binary)
    return metadata
  }

  const metadata = (result || {}) as AccountMetadata
  const fallbackBinary = getCachedMetadataAutomergeBinary() || Automerge.save(Automerge.from(metadata as Record<string, unknown>))
  sharedDecryptionCache.setMetadataBinary(fallbackBinary)
  return metadata
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  queryClient.clear()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(queryKeys.items) !== undefined
}
