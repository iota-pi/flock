import { useCallback, useSyncExternalStore } from 'react'
import type { Item } from '../state/items'
import { getAutomergeItem, subscribeAutomergeItem } from '../sync/automergeDocStore'

export function useAutomergeItem(itemId: string): Item | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeAutomergeItem(itemId, onStoreChange),
    [itemId],
  )
  const getSnapshot = useCallback(
    () => getAutomergeItem(itemId),
    [itemId],
  )

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  )
}
