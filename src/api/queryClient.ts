import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { getInitialAuthState, useAuthStore } from '../state/authStore'

export const queryKeys = {
  items: ['items'] as const,
  metadata: ['metadata'] as const,
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 2,
      refetchOnWindowFocus: true,
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