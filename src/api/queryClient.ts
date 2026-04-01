import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { getQueryKey } from '@trpc/react-query'
import { getInitialAuthState, useAuthStore } from '../state/authStore'
import { trpc } from './trpc'

function toLegacyQueryKey(key: ReturnType<typeof getQueryKey>): readonly string[] {
  if (!Array.isArray(key)) {
    return []
  }

  if (key.every(part => typeof part === 'string')) {
    return key as readonly string[]
  }

  const first = key[0]
  if (Array.isArray(first) && first.every(part => typeof part === 'string')) {
    return first as readonly string[]
  }

  return []
}

export const queryKeys = {
  items: toLegacyQueryKey(getQueryKey(trpc.items.fetchMany)),
  metadata: toLegacyQueryKey(getQueryKey(trpc.accounts.getMetadata)),
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 2,
    },
  },
})

const CACHE_KEY = 'flock-query-cache'

export const queryPersister = createAsyncStoragePersister({
  storage: window.localStorage,
  key: CACHE_KEY,
})

export function clearQueryCache() {
  queryClient.clear()
  const { setAccount } = useAuthStore.getState()
  setAccount(getInitialAuthState())
}

export async function invalidateItemsQuery() {
  await queryClient.invalidateQueries({ queryKey: queryKeys.items })
}

export async function invalidateMetadataQuery() {
  await queryClient.invalidateQueries({ queryKey: queryKeys.metadata })
}