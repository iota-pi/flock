import { useMutation, useQuery } from '@tanstack/react-query'
import type { UseQueryOptions } from '@tanstack/react-query'
import {
  vaultFetchMany,
  vaultGetMetadata,
  type VaultItem,
} from './VaultAPI'
import {
  Item,
  supplyMissingAttributes,
} from '../state/items'
import { AccountMetadata } from '../state/metadata'
import { checkAxios } from './axios'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import {
  mutateDeleteItems,
  mutateSetMetadata,
  mutateStoreItems,
} from './mutations'
import {
  queryClient,
  queryKeys,
  clearQueryCache as clearQueryClientCache,
} from './queryClient'
import { handleVaultError } from './runtime'
import migrateItems from '../state/migrations'

// Crypto helpers - these need the key from Vault.ts, so we import dynamically
async function getVaultModule() {
  return import('./Vault')
}

// Cache for decrypted items
const decryptionCache = new Map<string, { cipher: string, iv: string, item: Item }>()
let lastSyncModifiedAt: number | null = null

// Fetch and decrypt all items - TanStack Query handles caching
export async function decryptVaultItems(items: VaultItem[]): Promise<Item[]> {
  const vault = await getVaultModule()
  const decryptPromises = items.map(async (item, index) => {
    if (item.metadata?.deleted) {
      decryptionCache.delete(item.item)
      return null
    }

    const cipher = item.cipher
    const iv = item.metadata?.iv
    const id = item.item

    if (!cipher || !iv) {
      return Promise.reject(new Error(`Missing cipher or iv for item ${item.item ?? index}`))
    }

    // Check cache
    const cached = decryptionCache.get(id)
    if (cached && cached.cipher === cipher && cached.iv === iv) {
      return cached.item
    }

    // Decrypt and cache
    const decrypted = await vault.decryptObject({ cipher, iv }) as Item
    const filled = supplyMissingAttributes(decrypted)

    // Use server version if available as the source of truth
    if (typeof item.metadata?.version === 'number') {
      filled.version = item.metadata.version
    }

    decryptionCache.set(id, { cipher, iv, item: filled })
    return filled
  })

  const decryptedResults = await Promise.allSettled(decryptPromises)
  return decryptedResults.flatMap(result => {
    if (result.status === 'fulfilled') {
      if (result.value) {
        return [result.value]
      }
      return [] as Item[]
    }

    handleVaultError(result.reason as Error, 'Failed to decrypt item from server')
    return [] as Item[]
  })
}

export async function fetchItems(): Promise<Item[]> {
  if (!checkAxios()) {
    // If Axios isn't ready, we can't fetch.
    // Return empty array to satisfy the query temporarily.
    // The real fetch will happen once loadVault completes and triggers a refetch.
    return []
  }

  const cachedItems = queryClient.getQueryData<Item[]>(queryKeys.items) || []
  const hasCachedItems = cachedItems.length > 0
  const cacheTime = hasCachedItems && typeof lastSyncModifiedAt === 'number'
    ? lastSyncModifiedAt
    : null

  const items = await vaultFetchMany({ cacheTime }).catch(error => {
    handleVaultError(error, 'Failed to fetch items from server')
    return [] as VaultItem[]
  }) as VaultItem[]

  const maxModified = items.reduce((max, item) => {
    const modified = item.metadata?.modified
    return typeof modified === 'number' && modified > max ? modified : max
  }, lastSyncModifiedAt || 0)

  if (maxModified > 0) {
    lastSyncModifiedAt = maxModified
  }

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

function mergeDeltaItems(existing: Item[], delta: Item[], deletedIds: Set<string>): Item[] {
  const mergedMap = new Map(
    existing
      .filter(item => !deletedIds.has(item.id))
      .map(item => [item.id, item]),
  )

  for (const item of delta) {
    mergedMap.set(item.id, item)
  }

  return Array.from(mergedMap.values())
}

// Fetch and decrypt metadata
export async function fetchMetadata(): Promise<AccountMetadata> {
  const vault = await getVaultModule()
  const result = await vaultGetMetadata()
  let metadata: AccountMetadata

  if (result && 'cipher' in result && 'iv' in result) {
    metadata = await vault.decryptObject(result as { cipher: string; iv: string }) as AccountMetadata
    // Add version if it was passed alongside
    if ('version' in result && typeof result.version === 'number') {
      metadata.version = result.version
    }
  } else {
    // Backwards compatibility (10/07/21)
    metadata = result as AccountMetadata
  }
  return metadata
}

// Hook: Fetch items
export function useItemsQuery<TData = Item[]>(
  options?: Omit<UseQueryOptions<Item[], Error, TData>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.items,
    queryFn: fetchItems,
    enabled: options?.enabled ?? true,
  })
}

// Hook: Fetch metadata
export function useMetadataQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.metadata,
    queryFn: fetchMetadata,
    enabled,
  })
}

// Hook: Update metadata
export function useSetMetadataMutation() {
  return useMutation<AccountMetadata, Error, AccountMetadata | ((prev: AccountMetadata) => AccountMetadata), { previousMetadata: AccountMetadata | undefined }>({
    mutationFn: mutateSetMetadata,
    onMutate: async variables => {
      await queryClient.cancelQueries({ queryKey: queryKeys.metadata })

      const previousMetadata = queryClient.getQueryData<AccountMetadata>(queryKeys.metadata)
      const nextMetadata = typeof variables === 'function'
        ? variables(previousMetadata || {} as AccountMetadata)
        : variables

      queryClient.setQueryData<AccountMetadata>(queryKeys.metadata, nextMetadata)

      return { previousMetadata }
    },
    onError: (_error, _variables, context) => {
      queryClient.setQueryData(queryKeys.metadata, context?.previousMetadata)
    },
  })
}

// Hook: Store items mutation
export function useStoreItemsMutation() {
  return useMutation<Item[], Error, Item | Item[]>({
    mutationFn: items => mutateStoreItems(items),
  })
}

// Hook: Delete items mutation
export function useDeleteItemsMutation() {
  return useMutation({
    mutationFn: mutateDeleteItems,
  })
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  clearQueryClientCache()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(queryKeys.items) !== undefined
}
