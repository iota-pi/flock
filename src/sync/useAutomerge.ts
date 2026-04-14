import { useMemo, useSyncExternalStore } from 'react'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  getAutomergeItem,
  getAutomergeItems,
  getAutomergeMetadata,
  getAutomergeSnapshotVersion,
  subscribeAutomergeSnapshots,
} from './automergeDocStore'

const EMPTY_VERSION = 0
const EMPTY_ITEMS: Item[] = []
const EMPTY_METADATA: AccountMetadata = {}
const EMPTY_ITEM: Item | null = null

function subscribeAutomergeSnapshot(onStoreChange: () => void): () => void {
  return subscribeAutomergeSnapshots(onStoreChange)
}

function getAutomergeSnapshot(): number {
  return getAutomergeSnapshotVersion()
}

export function useAutomergeItems(): Item[] {
  const snapshotVersion = useSyncExternalStore(
    subscribeAutomergeSnapshot,
    getAutomergeSnapshot,
    () => EMPTY_VERSION,
  )

  return useMemo(
    () => {
      const items = getAutomergeItems()
      return items.length > 0 ? items : EMPTY_ITEMS
    },
    [snapshotVersion],
  )
}

export function useAutomergeItem(itemId: string): Item | null {
  const snapshotVersion = useSyncExternalStore(
    subscribeAutomergeSnapshot,
    getAutomergeSnapshot,
    () => EMPTY_VERSION,
  )

  return useMemo(
    () => getAutomergeItem(itemId) || EMPTY_ITEM,
    [itemId, snapshotVersion],
  )
}

export function useAutomergeMetadataSnapshot(): AccountMetadata {
  const snapshotVersion = useSyncExternalStore(
    subscribeAutomergeSnapshot,
    getAutomergeSnapshot,
    () => EMPTY_VERSION,
  )

  return useMemo(
    () => getAutomergeMetadata() || EMPTY_METADATA,
    [snapshotVersion],
  )
}
