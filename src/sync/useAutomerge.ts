import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl, DocHandle } from '@automerge/automerge-repo/slim'
import { z } from 'zod'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { accountMetadataSchema } from '../shared/schemas/metadata'
import { itemSchema } from '../shared/schemas/items'
import { ACCOUNT_METADATA_DOCUMENT_ID } from './automergeDocStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import {
  useOptimizedDocument,
  findRepoDocHandle,
  readReadySnapshot,
  readStableSnapshot,
} from './useOptimizedDocument'

const EMPTY_ITEMS: Item[] = []
const EMPTY_ITEM_IDS: string[] = []
const EMPTY_METADATA: AccountMetadata = {}


const automergeIndexDocumentSchema = z.looseObject({
  accountId: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
})

type RepoDoc = Record<string, unknown>
type RepoDocHandle = DocHandle<RepoDoc> | undefined
type AutomergeIndexDocument = z.infer<typeof automergeIndexDocumentSchema>
type ItemSchema<TItem extends Item> = z.ZodType<TItem>
type StableSnapshot<T> = {
  signature: string,
  value: T,
}

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
  const repo = useRepo()

  const indexUrl = useMemo(
    () => toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl,
    [],
  )

  const parseIndexItemIds = useCallback(
    (indexDoc: RepoDoc | undefined): string[] => {
      const parsedIndexDoc = parseWithSchema(indexDoc, automergeIndexDocumentSchema)
      return normalizeItemIds(parsedIndexDoc?.itemIds)
    },
    [],
  )

  const [itemIds] = useOptimizedDocument<RepoDoc, string[]>(
    indexUrl,
    parseIndexItemIds,
    EMPTY_ITEM_IDS,
    ['change', 'heads-changed', 'delete'],
  )

  const itemHandlesByUrlRef = useRef<Map<AutomergeUrl, RepoDocHandle>>(new Map())
  const snapshotRef = useRef<StableSnapshot<TItem[]> | null>(null)

  const resolveItemHandle = useCallback(
    (documentUrl: AutomergeUrl): RepoDocHandle => {
      const handlesByUrl = itemHandlesByUrlRef.current
      if (!handlesByUrl.has(documentUrl)) {
        handlesByUrl.set(documentUrl, findRepoDocHandle<RepoDoc>(repo, documentUrl))
      }

      return handlesByUrl.get(documentUrl)
    },
    [repo],
  )

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (itemIds.length === 0) {
        return () => {}
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null
      const cleanups: Array<() => void> = []
      const nextItemUrls = new Set<AutomergeUrl>()

      const scheduleStoreChange = () => {
        if (timeoutId !== null) {
          return
        }

        timeoutId = setTimeout(() => {
          timeoutId = null
          onStoreChange()
        }, 50)
      }

      for (const itemId of itemIds) {
        const documentUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl
        nextItemUrls.add(documentUrl)

        const handle = resolveItemHandle(documentUrl)
        if (!handle) {
          continue
        }

        handle.on('change', scheduleStoreChange)
        handle.on('heads-changed', scheduleStoreChange)
        handle.on('delete', scheduleStoreChange)

        cleanups.push(() => {
          handle.removeListener('change', scheduleStoreChange)
          handle.removeListener('heads-changed', scheduleStoreChange)
          handle.removeListener('delete', scheduleStoreChange)
        })
      }

      const cachedHandles = itemHandlesByUrlRef.current
      for (const documentUrl of Array.from(cachedHandles.keys())) {
        if (!nextItemUrls.has(documentUrl)) {
          cachedHandles.delete(documentUrl)
        }
      }

      return () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId)
        }

        for (const cleanup of cleanups) {
          cleanup()
        }
      }
    },
    [itemIds, resolveItemHandle],
  )

  const getSnapshot = useCallback(
    (): TItem[] => {
      const nextItemUrls = new Set<AutomergeUrl>()
      const parsedItems: TItem[] = []

      for (const itemId of itemIds) {
        const documentUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl
        nextItemUrls.add(documentUrl)

        const nextItem = parseItemFromDoc(
          itemId,
          readReadySnapshot(resolveItemHandle(documentUrl)),
          resolvedSchema,
        )
        if (nextItem) {
          parsedItems.push(nextItem)
        }
      }

      const cachedHandles = itemHandlesByUrlRef.current
      for (const documentUrl of Array.from(cachedHandles.keys())) {
        if (!nextItemUrls.has(documentUrl)) {
          cachedHandles.delete(documentUrl)
        }
      }

      return readStableSnapshot(
        parsedItems.length > 0 ? parsedItems : (EMPTY_ITEMS as TItem[]),
        snapshotRef,
      )
    },
    [itemIds, resolveItemHandle, resolvedSchema],
  )

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_ITEMS as TItem[],
  )
}

export function useAutomergeItemDocument<TItem extends Item = Item>(
  itemId: string,
  schema?: ItemSchema<TItem>,
): UseAutomergeItemDocumentResult<TItem> {
  const resolvedSchema = resolveItemSchema(schema)

  const documentUrl = useMemo(
    () => toAutomergeUrlFromItemId(itemId) as AutomergeUrl,
    [itemId],
  )

  const projectItemSnapshot = useCallback(
    (itemDoc: TItem | undefined): TItem | null => parseItemFromDoc(itemId, itemDoc, resolvedSchema),
    [itemId, resolvedSchema],
  )

  const [item, change] = useOptimizedDocument<TItem, TItem | null>(
    documentUrl,
    projectItemSnapshot,
    null,
  )

  return useMemo(
    () => ({
      item,
      change,
    }),
    [change, item],
  )
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
  const indexUrl = useMemo(
    () => toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl,
    [],
  )

  const projectMetadataSnapshot = useCallback(
    (indexDoc: RepoDoc | undefined): AccountMetadata => {
      const parsedIndexDoc = parseWithSchema(indexDoc, automergeIndexDocumentSchema) || undefined
      return normalizeMetadataFromIndex(parsedIndexDoc)
    },
    [],
  )

  const [metadata] = useOptimizedDocument<RepoDoc, AccountMetadata>(
    indexUrl,
    projectMetadataSnapshot,
    EMPTY_METADATA,
  )

  return metadata
}
