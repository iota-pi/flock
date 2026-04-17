import { useEffect, useMemo, useState } from 'react'
import { useDocument, useRepo } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl, DocHandle } from '@automerge/automerge-repo/slim'
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
type RepoDocHandle = DocHandle<RepoDoc> | undefined
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

function readReadySnapshot(handle: RepoDocHandle): RepoDoc | null {
  if (!handle || !handle.isReady() || handle.isUnavailable()) {
    return null
  }

  try {
    const doc = handle.doc()
    return (!doc || typeof doc !== 'object' || Array.isArray(doc)) ? null : (doc as RepoDoc)
  } catch {
    return null
  }
}

export function useAutomergeItems<TItem extends Item = Item>(schema?: ItemSchema<TItem>): TItem[] {
  const resolvedSchema = resolveItemSchema(schema)
  const repo = useRepo()

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

  const itemHandlesByUrl = useMemo(
    () => {
      const handles = new Map<AutomergeUrl, RepoDocHandle>()

      for (const documentUrl of itemUrls) {
        try {
          handles.set(documentUrl, repo.findWithProgress<RepoDoc>(documentUrl).handle as DocHandle<RepoDoc>)
        } catch {
          handles.set(documentUrl, undefined)
        }
      }

      return handles
    },
    [itemUrls, repo],
  )
  const [handleVersion, setHandleVersion] = useState(0)

  useEffect(
    () => {
      if (itemHandlesByUrl.size === 0) {
        return
      }

      let disposed = false
      const cleanups: Array<() => void> = []

      const bumpHandleVersion = () => {
        if (!disposed) {
          setHandleVersion(prev => prev + 1)
        }
      }

      itemHandlesByUrl.forEach(handle => {
        if (!handle) {
          return
        }

        handle.on('heads-changed', bumpHandleVersion)
        handle.on('change', bumpHandleVersion)
        handle.on('delete', bumpHandleVersion)

        cleanups.push(() => {
          handle.removeListener('heads-changed', bumpHandleVersion)
          handle.removeListener('change', bumpHandleVersion)
          handle.removeListener('delete', bumpHandleVersion)
        })
      })

      return () => {
        disposed = true
        for (const cleanup of cleanups) {
          cleanup()
        }
      }
    },
    [itemHandlesByUrl],
  )

  return useMemo(
    () => {
      // This invalidates memoized items when async handle readiness events resolve.
      void handleVersion
      const items: TItem[] = []

      for (let index = 0; index < itemIds.length; index += 1) {
        const itemId = itemIds[index]
        const documentUrl = itemUrls[index]

        if (!documentUrl) {
          continue
        }

        const nextItem = parseItemFromDoc(
          itemId,
          readReadySnapshot(itemHandlesByUrl.get(documentUrl)),
          resolvedSchema,
        )
        if (nextItem) {
          items.push(nextItem)
        }
      }

      return items.length > 0 ? items : (EMPTY_ITEMS as TItem[])
    },
    [handleVersion, itemHandlesByUrl, itemIds, itemUrls, resolvedSchema],
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
