import { useMutation, useQuery, useQueryClient, QueryClient } from '@tanstack/react-query'
import {
  vaultDelete,
  vaultDeleteMany,
  vaultFetchMany,
  vaultGetMetadata,
  vaultPut,
  vaultPutMany,
  vaultSetMetadata,
} from './VaultAPI'
import { checkProperties, Item, ItemId } from '../state/items'
import { AccountMetadata } from '../state/account'
import { VaultItem } from '../shared/apiTypes'
import { getAccountId } from './util'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import store from '../store'
import { pruneItems } from '../state/ui'
import { checkAxios } from './axios'
import { sortItems, DEFAULT_CRITERIA } from '../utils/customSort'

// Query Keys
export const queryKeys = {
  items: ['items'] as const,
  metadata: ['metadata'] as const,
}

// Create a query client instance with TanStack Query's native caching
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is considered fresh for 5 minutes
      staleTime: 5 * 60 * 1000,
      // Keep unused data in cache for 24 hours
      gcTime: 24 * 60 * 60 * 1000,
      retry: 2,
      // Refetch when user returns to the app
      refetchOnWindowFocus: true,
    },
  },
})

// Create a persister to save cache to localStorage
const CACHE_KEY = 'flock-query-cache'

export const queryPersister = createAsyncStoragePersister({
  storage: window.localStorage,
  key: CACHE_KEY,
})

// Crypto helpers - these need the key from Vault.ts, so we import dynamically
async function getVaultModule() {
  return import('./Vault')
}

function handleVaultError(error: Error, message: string) {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return
  }
  console.error(error)
  // Import dynamically to avoid circular dependency
  import('../state/ui').then(({ setUi }) => {
    import('../store').then(({ default: store }) => {
      store.dispatch(setUi({
        message: {
          message,
          severity: 'error',
        },
      }))
    })
  })
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
    decryptionCache.set(id, { cipher, iv, item: decrypted })
    return decrypted
  })

  const decryptedResults = await Promise.allSettled(decryptPromises)
  const successful = decryptedResults.flatMap(result => {
    if (result.status === 'fulfilled') {
      return [result.value]
    }

    handleVaultError(result.reason as Error, 'Failed to decrypt item from server')
    return [] as Item[]
  })

  return sortItems(successful, DEFAULT_CRITERIA)
}

// Fetch and decrypt metadata
async function fetchMetadata(): Promise<AccountMetadata> {
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
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (metadataOrUpdater: AccountMetadata | ((prev: AccountMetadata) => AccountMetadata)) => {
      const current = queryClient.getQueryData<AccountMetadata>(queryKeys.metadata) ?? {} as AccountMetadata
      const next = typeof metadataOrUpdater === 'function'
        ? metadataOrUpdater(current)
        : metadataOrUpdater
      const vault = await getVaultModule()
      const { cipher, iv } = await vault.encryptObject(next)
      await vaultSetMetadata({ cipher, iv })
      return next
    },
    onMutate: async metadataOrUpdater => {
      await queryClient.cancelQueries({ queryKey: queryKeys.metadata })

      const previousMetadata = queryClient.getQueryData<AccountMetadata>(queryKeys.metadata) ?? {} as AccountMetadata
      const nextMetadata = typeof metadataOrUpdater === 'function'
        ? metadataOrUpdater(previousMetadata)
        : metadataOrUpdater

      queryClient.setQueryData<AccountMetadata>(queryKeys.metadata, nextMetadata)

      return { previousMetadata }
    },
    onError: (err, _, context) => {
      if (context?.previousMetadata !== undefined) {
        queryClient.setQueryData(queryKeys.metadata, context.previousMetadata)
      }
      handleVaultError(err as Error, 'Failed to update metadata')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.metadata })
    },
  })
}

// Hook: Store items mutation
export function useStoreItemsMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (items: Item | Item[]) => {
      const vault = await getVaultModule()
      const itemArray = Array.isArray(items) ? items : [items]
      const checkResult = checkProperties(itemArray)
      if (checkResult.error) {
        throw new Error(checkResult.message)
      }

      const encrypted = await Promise.all(
        itemArray.map(item => vault.encryptObject(item)),
      )
      const modifiedTime = new Date().getTime()

      if (itemArray.length === 1) {
        await vaultPut({
          cipher: encrypted[0].cipher,
          item: itemArray[0].id,
          metadata: {
            iv: encrypted[0].iv,
            type: itemArray[0].type,
            modified: modifiedTime,
          },
        })
      } else {
        await vaultPutMany({
          items: encrypted.map(({ cipher, iv }, i) => ({
            account: getAccountId(),
            cipher,
            item: itemArray[i].id,
            metadata: {
              iv,
              type: itemArray[i].type,
              modified: modifiedTime,
            },
          })),
        })
      }

      return itemArray
    },
    onMutate: async items => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.items })

      // Snapshot the previous value
      const previousItems = queryClient.getQueryData<Item[]>(queryKeys.items)

      // Optimistically update
      const itemArray = Array.isArray(items) ? items : [items]
      queryClient.setQueryData<Item[]>(queryKeys.items, old => {
        if (!old) return itemArray
        const newItems = [...old]
        for (const item of itemArray) {
          const index = newItems.findIndex(i => i.id === item.id)
          if (index >= 0) {
            newItems[index] = item
          } else {
            newItems.push(item)
          }
        }
        return newItems
      })

      return { previousItems }
    },
    onError: (err, _, context) => {
      // Rollback on error
      if (context?.previousItems) {
        queryClient.setQueryData(queryKeys.items, context.previousItems)
      }
      handleVaultError(err as Error, 'Failed to store items')
    },
    onSettled: () => {
      // Always refetch after error or success
      queryClient.invalidateQueries({ queryKey: queryKeys.items })
    },
  })
}

// Hook: Delete items mutation
export function useDeleteItemsMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (itemIds: ItemId | ItemId[]) => {
      const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
      if (ids.length === 1) {
        await vaultDelete({ item: ids[0] })
      } else {
        await vaultDeleteMany({ items: ids })
      }
      return ids
    },
    onMutate: async itemIds => {
      await queryClient.cancelQueries({ queryKey: queryKeys.items })

      const previousItems = queryClient.getQueryData<Item[]>(queryKeys.items)
      const ids = Array.isArray(itemIds) ? itemIds : [itemIds]

      queryClient.setQueryData<Item[]>(queryKeys.items, old => {
        if (!old) return []
        return old.filter(item => !ids.includes(item.id))
      })

      return { previousItems }
    },
    onError: (err, _, context) => {
      if (context?.previousItems) {
        queryClient.setQueryData(queryKeys.items, context.previousItems)
      }
      handleVaultError(err as Error, 'Failed to delete items')
    },
    onSuccess: itemIds => {
      const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
      store.dispatch(pruneItems(ids))
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.items })
    },
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
