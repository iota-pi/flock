import { useMemo } from 'react'
import { useDocument, useDocuments } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import { z } from 'zod'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { accountMetadataSchema } from '../shared/schemas/metadata'
import { itemSchema } from '../shared/schemas/items'
import { ACCOUNT_METADATA_DOCUMENT_ID } from './automergeDocStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'

const EMPTY_ITEMS: Item[] = []
const EMPTY_METADATA: AccountMetadata = {}

const automergeIndexDocumentSchema = z.object({
  accountId: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough()

type RepoDoc = Record<string, unknown>
type AutomergeIndexDocument = z.infer<typeof automergeIndexDocumentSchema>
type ItemSchema<TItem extends Item> = z.ZodType<TItem>

const defaultItemSchema = itemSchema as ItemSchema<Item>

export type UseAutomergeItemDocumentResult<TItem extends Item> = {
  item: TItem | null
  change: (changeFn: (draft: TItem) => void) => void
}

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

function parseWithSchema<T>(value: unknown, schema: z.ZodType<T>): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function parseItemFromDoc<TItem extends Item>(
  itemId: string,
  rawDoc: unknown,
  schema: ItemSchema<TItem>,
): TItem | null {
  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
    return null
  }

  const snapshot = rawDoc as RepoDoc
  const normalizedItem = (typeof snapshot.id === 'string' && snapshot.id.length > 0)
    ? snapshot
    : { ...snapshot, id: itemId }

  return parseWithSchema(normalizedItem, schema)
}

function resolveItemSchema<TItem extends Item>(schema?: ItemSchema<TItem>): ItemSchema<TItem> {
  return (schema || defaultItemSchema) as ItemSchema<TItem>
}

export function useAutomergeItems<TItem extends Item = Item>(schema?: ItemSchema<TItem>): TItem[] {
  const resolvedSchema = resolveItemSchema(schema)

  const [indexDoc] = useDocument<AutomergeIndexDocument>(
    toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID),
    { suspense: true },
  )

  const parsedIndexDoc = useMemo(
    () => parseWithSchema(indexDoc, automergeIndexDocumentSchema),
    [indexDoc],
  )

  const itemIds = useMemo(
    () => normalizeItemIds(parsedIndexDoc?.itemIds),
    [parsedIndexDoc],
  )

  const itemUrls = useMemo(
    () => itemIds.map(itemId => toAutomergeUrlFromItemId(itemId) as AutomergeUrl),
    [itemIds],
  )

  const [itemDocsByUrl] = useDocuments<RepoDoc>(itemUrls, { suspense: true })

  return useMemo(
    () => {
      const items: TItem[] = []

      for (const itemId of itemIds) {
        const documentUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl
        const nextItem = parseItemFromDoc(itemId, itemDocsByUrl.get(documentUrl), resolvedSchema)
        if (nextItem) {
          items.push(nextItem)
        }
      }

      return items.length > 0 ? items : (EMPTY_ITEMS as TItem[])
    },
    [itemDocsByUrl, itemIds, resolvedSchema],
  )
}

export function useAutomergeItemDocument<TItem extends Item = Item>(
  itemId: string,
  schema?: ItemSchema<TItem>,
): UseAutomergeItemDocumentResult<TItem> {
  const resolvedSchema = resolveItemSchema(schema)

  const documentUrl = useMemo(
    () => toAutomergeUrlFromItemId(itemId),
    [itemId],
  )

  const [itemDoc, changeItemDoc] = useDocument<TItem>(documentUrl, { suspense: true })

  const item = useMemo(
    () => parseItemFromDoc(itemId, itemDoc, resolvedSchema),
    [itemDoc, itemId, resolvedSchema],
  )

  const change = useMemo(
    () => (changeFn: (draft: TItem) => void) => {
      changeItemDoc(changeFn)
    },
    [changeItemDoc],
  )

  return {
    item,
    change,
  }
}

export function useAutomergeItem<TItem extends Item = Item>(itemId: string, schema?: ItemSchema<TItem>): TItem | null {
  const { item } = useAutomergeItemDocument(itemId, schema)
  return item
}

function normalizeMetadataFromIndex(indexDoc: AutomergeIndexDocument | undefined): AccountMetadata {
  const metadata = parseWithSchema(indexDoc?.metadata, accountMetadataSchema)
  return metadata || EMPTY_METADATA
}

export function useAutomergeMetadataSnapshot(): AccountMetadata {
  const [indexDoc] = useDocument<AutomergeIndexDocument>(
    toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID),
    { suspense: true },
  )

  return useMemo(
    () => normalizeMetadataFromIndex(indexDoc),
    [indexDoc],
  )
}
