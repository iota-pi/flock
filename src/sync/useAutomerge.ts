import { useCallback, useSyncExternalStore } from 'react'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  getAutomergeItem,
  getAutomergeItems,
  getAutomergeMetadata,
  subscribeAutomergeItem,
  subscribeAutomergeItems,
  subscribeAutomergeMetadata,
} from './automergeDocStore'

const EMPTY_ITEMS: Item[] = []
const EMPTY_METADATA: AccountMetadata = {}
const EMPTY_ITEM: Item | null = null

export function useAutomergeItems(): Item[] {
  return useSyncExternalStore(
    subscribeAutomergeItems,
    () => {
      const items = getAutomergeItems()
      return items.length > 0 ? items : EMPTY_ITEMS
    },
    () => EMPTY_ITEMS,
  )
}

export function useAutomergeItem(itemId: string): Item | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeAutomergeItem(itemId, onStoreChange),
    [itemId],
  )
  const getSnapshot = useCallback(
    () => getAutomergeItem(itemId) || EMPTY_ITEM,
    [itemId],
  )

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_ITEM)
}

export function useAutomergeMetadataSnapshot(): AccountMetadata {
  return useSyncExternalStore(
    subscribeAutomergeMetadata,
    () => getAutomergeMetadata() || EMPTY_METADATA,
    () => EMPTY_METADATA,
  )
}
