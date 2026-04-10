import { useCallback, useSyncExternalStore } from 'react'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  getAutomergeItem,
  getAutomergeItemIds,
  getAutomergeItems,
  getAutomergeMetadata,
  subscribeAutomergeItem,
  subscribeAutomergeItems,
  subscribeAutomergeMetadata,
} from './automergeDocStore'

const EMPTY_ITEMS: Item[] = []
const EMPTY_ITEM_IDS: string[] = []
const EMPTY_METADATA: AccountMetadata = {}
const EMPTY_ITEM: Item | null = null

export function useAutomergeItems(): Item[] {
  return useSyncExternalStore(
    subscribeAutomergeItems,
    getAutomergeItems,
    () => EMPTY_ITEMS,
  )
}

export function useAutomergeItemIds(): string[] {
  return useSyncExternalStore(
    subscribeAutomergeItems,
    getAutomergeItemIds,
    () => EMPTY_ITEM_IDS,
  )
}

export function useAutomergeItem(itemId: string): Item | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeAutomergeItem(itemId, listener),
    [itemId],
  )

  const getSnapshot = useCallback(
    () => getAutomergeItem(itemId),
    [itemId],
  )

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_ITEM,
  )
}

export function useAutomergeMetadataSnapshot(): AccountMetadata {
  return useSyncExternalStore(
    subscribeAutomergeMetadata,
    getAutomergeMetadata,
    () => EMPTY_METADATA,
  )
}
