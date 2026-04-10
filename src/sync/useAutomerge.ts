import { useSyncExternalStore } from 'react'
import { useDocument } from '@automerge/automerge-repo-react-hooks'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  getAutomergeItemIds,
  getAutomergeItems,
  getAutomergeMetadata,
  subscribeAutomergeItems,
  subscribeAutomergeMetadata,
} from './automergeDocStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'

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
  const [item] = useDocument<Item>(toAutomergeUrlFromItemId(itemId), {
    suspense: false,
  })

  return item || EMPTY_ITEM
}

export function useAutomergeMetadataSnapshot(): AccountMetadata {
  return useSyncExternalStore(
    subscribeAutomergeMetadata,
    getAutomergeMetadata,
    () => EMPTY_METADATA,
  )
}
