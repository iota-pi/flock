import {
  fetchMany,
  getMetadata,
  type VaultMetadataEnvelope,
  type VaultItem,
} from './vault/client'
import * as vault from './vault'
import { trpcClient } from './trpcClient'
import {
  Item,
  mergeDeltaItems,
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
import {
  setCachedAutomergeBinary,
  getCachedMetadataAutomergeBinary,
  setCachedMetadataAutomergeBinary,
} from '../sync/automergeBinaryCache'
import type { VaultEnvelope } from '../vault/types'
import {
  decryptItemsInWorker,
  maybeCompactItemInWorker,
} from '../workers/decryptionWorkerManager'
import { sharedDecryptionCache } from './vault/DecryptionCache'
import { getEnvelopeCacheKey } from './vault/decryptionCacheKey'
import { decryptVaultEnvelope } from './vault/decryptVaultEnvelope'
import { getLastSyncServerTime } from '../sync/syncServerTimeStore'
import { initializeSyncHealthWatchers } from './syncHealthCoordinator'

function toItemEnvelope(item: VaultItem): VaultEnvelope | null {
  if (typeof item.cipher === 'string') {
    return {
      kind: 'legacy',
      cipher: item.cipher,
      iv: item.metadata.iv,
    }
  }

  if (Array.isArray(item.branches)) {
    return {
      kind: 'branching',
      branches: item.branches,
    }
  }

  return null
}

function toMetadataEnvelope(metadata: VaultMetadataEnvelope): VaultEnvelope | null {
  if (metadata && typeof metadata === 'object' && 'branches' in metadata && Array.isArray(metadata.branches)) {
    return {
      kind: 'branching',
      branches: metadata.branches,
    }
  }

  if (metadata && typeof metadata === 'object' && 'cipher' in metadata && typeof metadata.cipher === 'string' && 'iv' in metadata && typeof metadata.iv === 'string') {
    return {
      kind: 'legacy',
      cipher: metadata.cipher,
      iv: metadata.iv,
    }
  }

  return null
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

    const envelope = toItemEnvelope(item)
    if (!envelope) {
      handleVaultError(new Error(`Missing payload for item ${item.item ?? index}`), 'Failed to decrypt item from server')
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
    handleVaultError(error as Error, 'Failed to decrypt item from server')
    return []
  })

  const sourcesById = new Map(items.map(item => [item.item, item]))

  return decrypted
    .map(item => {
      const id = (item as { id?: unknown }).id
      if (typeof id !== 'string') {
        return null
      }

      const workerItem = item as { automergeBinary?: unknown } & Record<string, unknown>
      const source = sourcesById.get(id)
      if (!source) {
        return null
      }

      const automergeBinary = workerItem.automergeBinary
      if (automergeBinary instanceof Uint8Array) {
        maybeCompactItemInWorker({
          key,
          source,
          automergeBinary,
          onCompacted: async compacted => {
            if (!hasApiAuthToken()) {
              return
            }

            await trpcClient.items.compactItem.mutate({
              account: getAccountId(),
              item: compacted.itemId,
              baseVersionId: compacted.baseVersionId,
              compactedBranch: compacted.compactedBranch,
              idempotencyKey: `compact-${compacted.itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            })

            setCachedAutomergeBinary(compacted.itemId, compacted.compactedBinary)

            const compactedEnvelope: VaultEnvelope = {
              kind: 'branching',
              branches: [compacted.compactedBranch],
            }
            const cached = sharedDecryptionCache.get(compacted.itemId)
            if (cached) {
              sharedDecryptionCache.set(compacted.itemId, {
                ...cached,
                cacheKey: getEnvelopeCacheKey(compactedEnvelope),
              })
              sharedDecryptionCache.schedulePersist(getAccountId())
            }
          },
          onError: error => {
            const itemId = source.item
            console.warn(`[Compaction] watcher failed for item ${itemId}`, error)
          },
        }).catch(error => {
          console.warn(`[Compaction] watcher failed for item ${id}`, error)
        })
      }

      const { automergeBinary: _automergeBinary, ...materialized } = workerItem
      return hydrateAndCacheItem({
        accountId,
        source,
        materialized: materialized as unknown as Item,
        automergeBinary: automergeBinary instanceof Uint8Array ? automergeBinary : undefined,
      })
    })
    .filter((item): item is Item => !!item)
}

async function decryptWithoutWorker(
  accountId: string,
  vaultModule: typeof vault,
  items: VaultItem[],
): Promise<Item[]> {
  const decryptedResults = await Promise.allSettled(
    items.map(async source => {
      const envelope = toItemEnvelope(source)
      if (!envelope) {
        throw new Error(`Missing payload for item ${source.item}`)
      }

      const decrypted = await decryptVaultEnvelope<Item>({
        envelope,
        key: vaultModule.getVaultKey(),
        decryptLegacyEnvelope: vaultModule.decryptObject,
      })

      return hydrateAndCacheItem({
        accountId,
        source,
        materialized: decrypted.materialized,
        automergeBinary: decrypted.automergeBinary,
      })
    }),
  )

  return decryptedResults.flatMap(result => {
    if (result.status === 'fulfilled') {
      return [result.value]
    }

    handleVaultError(result.reason as Error, 'Failed to decrypt item from server')
    return [] as Item[]
  })
}

export async function fetchItems(): Promise<Item[]> {
  if (!hasApiAuthToken()) {
    // If API isn't ready to use (no auth token), we can't fetch.
    // Return empty array to satisfy the query temporarily.
    // The real fetch will happen once loadVault completes and triggers a refetch.
    return []
  }

  const cachedItems = queryClient.getQueryData<Item[]>(queryKeys.items) || []
  const hasCachedItems = cachedItems.length > 0
  const accountId = getAccountId()
  const lastSyncServerTime = getLastSyncServerTime(accountId)
  const cacheTime = hasCachedItems && typeof lastSyncServerTime === 'number'
    ? lastSyncServerTime
    : null

  const response = await fetchMany({ cacheTime }).catch(error => {
    handleVaultError(error, 'Failed to fetch items from server')
    return { items: [] as VaultItem[], serverTime: lastSyncServerTime || 0 }
  })

  const items = response.items as VaultItem[]

  const decrypted = await decryptVaultItems(items)
  const deletedIds = new Set(
    items
      .filter(item => item.metadata?.deleted === true)
      .map(item => item.item),
  )

  const mergedItems = cacheTime === null
    ? decrypted
    : mergeDeltaItems(cachedItems, decrypted, deletedIds)

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

  const envelope = toMetadataEnvelope(result)
  if (envelope) {
    const decrypted = await decryptVaultEnvelope<AccountMetadata>({
      envelope,
      key: vault.getVaultKey(),
      decryptLegacyEnvelope: vault.decryptObject,
    })

    const metadata = decrypted.materialized
    const binary = decrypted.automergeBinary || Automerge.save(Automerge.from(metadata as Record<string, unknown>))
    setCachedMetadataAutomergeBinary(binary)
    return metadata
  }

  const metadata = (result || {}) as AccountMetadata
  const fallbackBinary = getCachedMetadataAutomergeBinary() || Automerge.save(Automerge.from(metadata as Record<string, unknown>))
  setCachedMetadataAutomergeBinary(fallbackBinary)
  return metadata
}

function hydrateAndCacheItem(input: {
  accountId: string
  source: VaultItem
  materialized: Item
  automergeBinary?: Uint8Array
}): Item {
  if (input.automergeBinary) {
    setCachedAutomergeBinary(input.source.item, input.automergeBinary)
  }

  const filled = supplyMissingAttributes(input.materialized)
  const envelope = toItemEnvelope(input.source)

  if (envelope) {
    sharedDecryptionCache.set(input.source.item, {
      cacheKey: getEnvelopeCacheKey(envelope),
      item: filled,
    })
    sharedDecryptionCache.schedulePersist(input.accountId)
  }

  return filled
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  queryClient.clear()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(queryKeys.items) !== undefined
}
