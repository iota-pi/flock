import { useMemo } from 'react'
import { useDocument, useDocuments } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  type AutomergeIndexDocument,
  ACCOUNT_METADATA_DOCUMENT_ID,
} from './automergeDocStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'

const EMPTY_ITEMS: Item[] = []
const EMPTY_METADATA: AccountMetadata = {}
const EMPTY_ITEM: Item | null = null

type RepoDoc = Record<string, unknown>

function normalizeItemIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return []
  }

  const deduped = new Set<string>()

  for (const entry of raw) {
    if (typeof entry !== 'string') {
      continue
    }

    const normalized = entry.trim()
    if (normalized.length === 0 || deduped.has(normalized)) {
      continue
    }

    deduped.add(normalized)
  }

  return Array.from(deduped)
}

function normalizeItemFromDoc(itemId: string, rawDoc: unknown): Item | null {
  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
    return null
  }

  const snapshot = rawDoc as Partial<Item>
  const normalizedItem = (typeof snapshot.id === 'string' && snapshot.id.length > 0)
    ? snapshot
    : { ...snapshot, id: itemId }

  if (typeof normalizedItem.type !== 'string' || normalizedItem.type.length === 0) {
    return null
  }

  return normalizedItem as Item
}

export function useAutomergeItems(): Item[] {
  const [indexDoc] = useDocument<AutomergeIndexDocument>(
    toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID),
    { suspense: false },
  )

  const itemIds = useMemo(
    () => normalizeItemIds(indexDoc?.itemIds),
    [indexDoc],
  )

  const itemUrls = useMemo(
    () => itemIds.map(itemId => toAutomergeUrlFromItemId(itemId) as AutomergeUrl),
    [itemIds],
  )

  const [itemDocsByUrl] = useDocuments<RepoDoc>(itemUrls, { suspense: false })

  return useMemo(
    () => {
      const items: Item[] = []

      for (const itemId of itemIds) {
        const documentUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl
        const nextItem = normalizeItemFromDoc(itemId, itemDocsByUrl.get(documentUrl))
        if (nextItem) {
          items.push(nextItem)
        }
      }

      return items.length > 0 ? items : EMPTY_ITEMS
    },
    [itemDocsByUrl, itemIds],
  )
}

export function useAutomergeItem(itemId: string): Item | null {
  const documentUrl = useMemo(
    () => toAutomergeUrlFromItemId(itemId),
    [itemId],
  )

  const [itemDoc] = useDocument<RepoDoc>(documentUrl, { suspense: false })

  return useMemo(
    () => normalizeItemFromDoc(itemId, itemDoc) || EMPTY_ITEM,
    [itemDoc, itemId],
  )
}

export function useAutomergeMetadataSnapshot(): AccountMetadata {
  const [indexDoc] = useDocument<AutomergeIndexDocument>(
    toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID),
    { suspense: false },
  )

  return useMemo(
    () => {
      const metadata = indexDoc?.metadata
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return EMPTY_METADATA
      }

      return metadata
    },
    [indexDoc],
  )
}
