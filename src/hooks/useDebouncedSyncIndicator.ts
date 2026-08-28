import { useEffect, useState } from 'react'
import { useAppStore } from '../state/store'

/**
 * Hook to debounce the visual sync/loading indicator in the UI.
 *
 * When syncing starts (activeRequests > 0 or syncStatus === 'syncing'), the indicator
 * turns on immediately for responsive user feedback.
 *
 * When syncing stops, turning off the indicator is debounced by `debounceMs` (default 100ms)
 * to prevent flickering between rapid consecutive requests (idle -> syncing -> idle).
 */
export function useDebouncedSyncIndicator(
  isSyncingProp?: boolean,
  debounceMs: number = 100,
): boolean {
  const storeActiveRequests = useAppStore(state => state.activeRequests)
  const storeSyncStatus = useAppStore(state => state.syncStatus)

  const isSyncing = isSyncingProp !== undefined
    ? isSyncingProp
    : storeActiveRequests > 0 || storeSyncStatus === 'syncing'

  const [debouncedState, setDebouncedState] = useState<boolean>(isSyncing)
  const [prevIsSyncing, setPrevIsSyncing] = useState<boolean>(isSyncing)

  if (isSyncing !== prevIsSyncing) {
    setPrevIsSyncing(isSyncing)
    if (isSyncing) {
      setDebouncedState(true)
    }
  }

  useEffect(() => {
    if (!isSyncing) {
      const timer = setTimeout(() => {
        setDebouncedState(false)
      }, debounceMs)

      return () => {
        clearTimeout(timer)
      }
    }
  }, [isSyncing, debounceMs])

  return debouncedState
}

export default useDebouncedSyncIndicator
