import { useMutation, useQuery, useQueryClient, QueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
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
import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client'

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

export const queryPersister: Persister = {
  persistClient: async (client: PersistedClient) => {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(client))
    } catch {
      // Ignore storage errors (e.g., quota exceeded)
    }
  },
  restoreClient: async () => {
    try {
      const cached = localStorage.getItem(CACHE_KEY)
      return cached ? JSON.parse(cached) as PersistedClient : undefined
    } catch {
      return undefined
    }
  },
  removeClient: async () => {
    localStorage.removeItem(CACHE_KEY)
  },
}

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

// Fetch and decrypt all items - TanStack Query handles caching
export async function fetchItems(): Promise<Item[]> {
  const vault = await getVaultModule()
  // Pass cacheTime: null to fetch all items (no incremental fetch)
  const items = await vaultFetchMany({ cacheTime: null }).catch(error => {
    handleVaultError(error, 'Failed to fetch items from server')
    return [] as VaultItem[]
  })
  const decrypted = await Promise.all(
    items.map(
      item => vault.decryptObject({
        cipher: item.cipher!,
        iv: item.metadata!.iv,
      }) as Promise<Item>,
    ),
  )
  return decrypted
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
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.items })
    },
  })
}

// Hook: Update metadata mutation
export function useUpdateMetadataMutation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (metadata: AccountMetadata) => {
      const vault = await getVaultModule()
      const { cipher, iv } = await vault.encryptObject(metadata)
      await vaultSetMetadata({ cipher, iv })
      return metadata
    },
    onMutate: async metadata => {
      await queryClient.cancelQueries({ queryKey: queryKeys.metadata })

      const previousMetadata = queryClient.getQueryData<AccountMetadata>(queryKeys.metadata)

      queryClient.setQueryData<AccountMetadata>(queryKeys.metadata, metadata)

      return { previousMetadata }
    },
    onError: (err, _, context) => {
      if (context?.previousMetadata) {
        queryClient.setQueryData(queryKeys.metadata, context.previousMetadata)
      }
      handleVaultError(err as Error, 'Failed to update metadata')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.metadata })
    },
  })
}

// Helper hook for components that need to store items
export function useStoreItems() {
  const mutation = useStoreItemsMutation()
  return useCallback(
    (items: Item | Item[]) => mutation.mutateAsync(items),
    [mutation],
  )
}

// Helper hook for components that need to delete items
export function useDeleteItems() {
  const mutation = useDeleteItemsMutation()
  return useCallback(
    (itemIds: ItemId | ItemId[]) => mutation.mutateAsync(itemIds),
    [mutation],
  )
}

// Helper hook for getting items from the query cache
export function useQueryItems<T extends Item>(itemType?: T['type']): T[] {
  const { data: items = [] } = useItemsQuery()
  if (itemType) {
    return items.filter(i => i.type === itemType) as T[]
  }
  return items as T[]
}

// Helper hook for getting a single item
export function useQueryItem(id: ItemId): Item | undefined {
  const { data: items = [] } = useItemsQuery()
  return items.find(item => item.id === id)
}

// Helper hook for getting metadata
export function useQueryMetadata<K extends keyof AccountMetadata>(
  key: K,
  defaultValue?: AccountMetadata[K],
): [AccountMetadata[K] | undefined, (value: AccountMetadata[K]) => void] {
  const { data: metadata } = useMetadataQuery()
  const updateMutation = useUpdateMetadataMutation()

  const value = metadata?.[key] ?? defaultValue
  const setValue = useCallback(
    (newValue: AccountMetadata[K]) => {
      updateMutation.mutate({
        ...metadata,
        [key]: newValue,
      } as AccountMetadata)
    },
    [key, metadata, updateMutation],
  )

  return [value, setValue]
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  queryClient.clear()
}

// Helper to check if we have cached data (for UI purposes)
export function hasItemsInCache(): boolean {
  return queryClient.getQueryData(queryKeys.items) !== undefined
}
