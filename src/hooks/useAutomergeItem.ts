import { useSyncExternalStore } from 'react'
import type { Item } from '../state/items'
import { getAutomergeItem, subscribeAutomergeItem } from '../sync/automergeDocStore'

export function useAutomergeItem(itemId: string): Item | null {
  return useSyncExternalStore(
    onStoreChange => subscribeAutomergeItem(itemId, () => onStoreChange()),
    () => getAutomergeItem(itemId),
    () => getAutomergeItem(itemId),
  )
}
