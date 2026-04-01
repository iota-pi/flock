import { skipToken } from '@tanstack/react-query'
import { trpc } from './trpc'
import { useAuthStore } from '../state/authStore'
import type { ItemId } from '../shared/itemTypes'

type RawFetchManyOutput = {
  success: boolean
  items: unknown[]
  nextCursor: string | null
  serverTime: number
}

type RawMetadataOutput = {
  success: boolean
  metadata: unknown
}

type RawItemsInput = {
  cacheTime?: number | null
  ids?: ItemId[]
}

type RawQueryOptions = {
  enabled?: boolean
  staleTime?: number
  gcTime?: number
  refetchOnWindowFocus?: boolean
}

export function useRawItemsQuery<TData = RawFetchManyOutput>(
  input: RawItemsInput = {},
  options: RawQueryOptions = {},
) {
  const account = useAuthStore(state => state.account)
  const queryInput = account ? { account, ...input } : skipToken

  return trpc.items.fetchMany.useQuery(queryInput, {
    ...options,
    enabled: (options?.enabled ?? true) && Boolean(account),
  }) as unknown as { data: TData | undefined }
}

export function useRawMetadataQuery<TData = RawMetadataOutput>(
  options: RawQueryOptions = {},
) {
  const account = useAuthStore(state => state.account)
  const queryInput = account ? { account } : skipToken

  return trpc.accounts.getMetadata.useQuery(queryInput, {
    ...options,
    enabled: (options?.enabled ?? true) && Boolean(account),
  }) as unknown as { data: TData | undefined }
}

export function useVaultQueryUtils() {
  const utils = trpc.useUtils()

  return {
    invalidateItems: async () => {
      await utils.items.fetchMany.invalidate()
    },
    invalidateMetadata: async () => {
      await utils.accounts.getMetadata.invalidate()
    },
  }
}
