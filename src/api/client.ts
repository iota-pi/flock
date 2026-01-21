import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import { setUi } from '../state/ui'
import store from '../store'

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

// Error handling helper
export function handleVaultError(error: Error, message: string) {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    return
  }
  console.error(error)
  store.dispatch(setUi({
    message: {
      message,
      severity: 'error',
    },
  }))
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  queryClient.clear()
}
