import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { getQueryKey } from '@trpc/react-query'
import { getInitialAuthState, useAuthStore } from '../state/authStore'
import { trpc } from './trpc'

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
  await queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.items.fetchMany) })
}

export async function invalidateMetadataQuery() {
  await queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.accounts.getMetadata) })
}