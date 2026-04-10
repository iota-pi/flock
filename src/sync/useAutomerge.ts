import { useSyncExternalStore } from 'react'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  getAutomergeItems,
  getAutomergeMetadata,
  subscribeAutomergeItems,
  subscribeAutomergeMetadata,
} from './automergeDocStore'

const EMPTY_ITEMS: Item[] = []
const EMPTY_METADATA: AccountMetadata = {}

export function useAutomergeItems(): Item[] {
  return useSyncExternalStore(
    subscribeAutomergeItems,
    getAutomergeItems,
    () => EMPTY_ITEMS,
  )
}

export function useAutomergeMetadataSnapshot(): AccountMetadata {
  return useSyncExternalStore(
    subscribeAutomergeMetadata,
    getAutomergeMetadata,
    () => EMPTY_METADATA,
  )
}
