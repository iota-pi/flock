import { useMutation, useQuery } from '@tanstack/react-query'
import type { UseQueryOptions } from '@tanstack/react-query'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import type { ItemId } from '../shared/itemTypes'
import { fetchItems, fetchMetadata } from './queries'
import { mutateDeleteItems, mutateSetMetadata, mutateStoreItems } from './mutations'
import { queryClient, queryKeys } from './queryClient'

export function useItemsViewQuery<TData = Item[]>(
  options?: Omit<UseQueryOptions<Item[], Error, TData>, 'queryKey' | 'queryFn'>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.items,
    queryFn: fetchItems,
    enabled: options?.enabled ?? true,
  })
}

export function useMetadataViewQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.metadata,
    queryFn: fetchMetadata,
    enabled,
  })
}

export function useSetMetadataViewMutation() {
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

export function useStoreItemsViewMutation() {
  return useMutation<Item[], Error, Item | Item[]>({
    mutationFn: items => mutateStoreItems(items),
  })
}

export function useDeleteItemsViewMutation() {
  return useMutation<ItemId[] | ItemId, Error, ItemId | ItemId[]>({
    mutationFn: mutateDeleteItems,
  })
}
