import { useMemo, useSyncExternalStore } from 'react'
import { useDocument, useDocuments } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import { createStore } from 'zustand/vanilla'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { ACCOUNT_METADATA_DOCUMENT_ID } from './automergeDocStore'
import { getVaultNetworkAdapter } from './automergeRepo'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'

const EMPTY_ITEM_IDS: string[] = []
const EMPTY_METADATA: AccountMetadata = {}
const EMPTY_ITEM: Item | null = null
const INITIAL_KNOWN_ITEM_IDS_VERSION = -1

type KnownItemIdsSnapshotState = {
  version: number
  itemIds: string[]
}

const knownItemIdsSnapshotStore = createStore<KnownItemIdsSnapshotState>(() => ({
  version: INITIAL_KNOWN_ITEM_IDS_VERSION,
  itemIds: EMPTY_ITEM_IDS,
}))

function refreshKnownItemIdsSnapshot(): void {
  const adapter = getVaultNetworkAdapter()
  const { version, itemIds } = adapter.getKnownItemIdsState()
  const current = knownItemIdsSnapshotStore.getState()

  if (current.version === version) {
    return
  }

  const nextSnapshot = itemIds
    .filter(itemId => itemId !== ACCOUNT_METADATA_DOCUMENT_ID)

  knownItemIdsSnapshotStore.setState({
    version,
    itemIds: nextSnapshot.length > 0 ? nextSnapshot : EMPTY_ITEM_IDS,
  })
}

function subscribeKnownItemIds(onStoreChange: () => void): () => void {
  refreshKnownItemIdsSnapshot()

  return getVaultNetworkAdapter().subscribeKnownItemIds(() => {
    refreshKnownItemIdsSnapshot()
    onStoreChange()
  })
}

function getKnownItemIdsSnapshot(): string[] {
  refreshKnownItemIdsSnapshot()
  return knownItemIdsSnapshotStore.getState().itemIds
}

export function useAutomergeItems(): Item[] {
  const itemIds = useAutomergeItemIds()
  const itemUrls = useMemo(
    () => itemIds.map(itemId => toAutomergeUrlFromItemId(itemId) as AutomergeUrl),
    [itemIds],
  )

  const [documents] = useDocuments<Item>(itemUrls, {
    suspense: false,
  })

  return useMemo(
    () => itemUrls
      .map(itemUrl => documents.get(itemUrl))
      .filter((item): item is Item => !!item),
    [documents, itemUrls],
  )
}

function useAutomergeItemIds(): string[] {
  return useSyncExternalStore(
    subscribeKnownItemIds,
    getKnownItemIdsSnapshot,
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
  const [metadata] = useDocument<AccountMetadata>(toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID), {
    suspense: false,
  })

  return metadata || EMPTY_METADATA
}
