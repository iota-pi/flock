import { useMutation, useQuery } from '@tanstack/react-query'
import {
  vaultFetchMany,
  vaultGetMetadata,
} from './VaultAPI'
import {
  Item,
  supplyMissingAttributes,
} from '../state/items'
import { AccountMetadata } from '../state/account'
import { VaultItem } from '../shared/apiTypes'
import { checkAxios } from './axios'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'
import {
  mutateDeleteItems,
  mutateSetMetadata,
  mutateStoreItems,
} from './mutations'
import { handleVaultError, queryClient, queryKeys } from './client'
import migrateItems from '../state/migrations'

// Crypto helpers - these need the key from Vault.ts, so we import dynamically
async function getVaultModule() {
  return import('./Vault')
}

// Cache for decrypted items
const decryptionCache = new Map<string, { cipher: string, iv: string, item: Item }>()

// Fetch and decrypt all items - TanStack Query handles caching
export async function fetchItems(): Promise<Item[]> {
  if (!checkAxios) {
    // If Axios isn't ready, we can't fetch.
    // Return empty array to satisfy the query temporarily.
    // The real fetch will happen once loadVault completes and triggers a refetch.
    return []
  }

  const vault = await getVaultModule()
  // Pass cacheTime: null to fetch all items (no incremental fetch)
  const items = await vaultFetchMany({ cacheTime: null }).catch(error => {
    handleVaultError(error, 'Failed to fetch items from server')
    return [] as VaultItem[]
  })

  const decryptPromises = items.map(async (item, index) => {
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
    decryptionCache.set(id, { cipher, iv, item: filled })
    return filled
  })

  const decryptedResults = await Promise.allSettled(decryptPromises)
  const successful = decryptedResults.flatMap(result => {
    if (result.status === 'fulfilled') {
      return [result.value]
    }

    handleVaultError(result.reason as Error, 'Failed to decrypt item from server')
    return [] as Item[]
  })

  // Run migrations
  try {
    const metadata = await queryClient.fetchQuery({
      queryKey: queryKeys.metadata,
      queryFn: fetchMetadata,
      staleTime: 5 * 60 * 1000,
    })
    await migrateItems(successful, metadata)
  } catch (err) {
    console.error('Migration check failed during fetchItems', err)
  }

  return sortItems(successful, DEFAULT_CRITERIA)
}

// Fetch and decrypt metadata
export async function fetchMetadata(): Promise<AccountMetadata> {
  const vault = await getVaultModule()
  const result = await vaultGetMetadata()
  try {
    return await vault.decryptObject(result as { cipher: string; iv: string }) as AccountMetadata
  } catch (error) {
    if (result && 'cipher' in result && 'iv' in result) {
      throw error
    }
    // Backwards compatibility (10/07/21)
    return result as AccountMetadata
  }
}

// Hook: Fetch items
export function useItemsQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.items,
    queryFn: fetchItems,
    enabled,
    refetchOnMount: 'always',
  })
}

// Hook: Fetch metadata
export function useMetadataQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.metadata,
    queryFn: fetchMetadata,
    enabled,
    refetchOnMount: 'always',
  })
}

// Hook: Update metadata
export function useSetMetadataMutation() {
  return useMutation({
    mutationFn: mutateSetMetadata,
  })
}

// Hook: Store items mutation
export function useStoreItemsMutation() {
  return useMutation({
    mutationFn: mutateStoreItems,
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
  queryClient.clear()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(queryKeys.items) !== undefined
}
