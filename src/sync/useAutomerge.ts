import { useMemo, useSyncExternalStore } from 'react'
import { useDocument, useDocuments } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { ACCOUNT_METADATA_DOCUMENT_ID } from './automergeDocStore'
import { getVaultNetworkAdapter } from './automergeRepo'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'

const EMPTY_ITEM_IDS: string[] = []
const EMPTY_METADATA: AccountMetadata = {}
const EMPTY_ITEM: Item | null = null
let cachedKnownItemIdsSnapshot: string[] = EMPTY_ITEM_IDS

function subscribeKnownItemIds(onStoreChange: () => void): () => void {
  return getVaultNetworkAdapter().subscribeKnownItemIds(() => {
    onStoreChange()
  })
}

function getKnownItemIdsSnapshot(): string[] {
  const nextSnapshot = getVaultNetworkAdapter()
    .getKnownItemIds()
    .filter(itemId => itemId !== ACCOUNT_METADATA_DOCUMENT_ID)

  if (cachedKnownItemIdsSnapshot.length === nextSnapshot.length) {
    const hasChanged = cachedKnownItemIdsSnapshot.some((itemId, index) => itemId !== nextSnapshot[index])
    if (!hasChanged) {
      return cachedKnownItemIdsSnapshot
    }
  }

  cachedKnownItemIdsSnapshot = nextSnapshot
  return cachedKnownItemIdsSnapshot
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

export function useAutomergeItemIds(): string[] {
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
