import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import { z } from 'zod'
import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { accountMetadataSchema } from '../shared/schemas/metadata'
import { itemSchema } from '../shared/schemas/items'
import { ACCOUNT_METADATA_DOCUMENT_ID } from './automergeDocStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { createDebouncedNotifier, normalizeItemIds, parseWithSchema } from './syncUtils'
import {
  useOptimizedDocument,
  findRepoDocHandle,
  readReadySnapshot,
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
type Repo = ReturnType<typeof useRepo>
type AutomergeIndexDocument = z.infer<typeof automergeIndexDocumentSchema>
type ItemSchema<TItem extends Item> = z.ZodType<TItem>

type ParsedItemsByUrl<TItem extends Item> = Map<AutomergeUrl, WeakMap<object, TItem | null>>

type ItemsStoreState<TItem extends Item> = {
  repo: Repo
  schema: ItemSchema<TItem>
  itemIds: string[]
  parsedItemsByUrl: ParsedItemsByUrl<TItem>
  snapshot: TItem[]
}

const defaultItemSchema = itemSchema as ItemSchema<Item>

export type UseAutomergeItemDocumentResult<TItem extends Item> = {
  item: TItem | null
  change: (changeFn: (draft: TItem) => void) => void
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

function toItemDocumentUrl(itemId: string): AutomergeUrl {
  return toAutomergeUrlFromItemId(itemId) as AutomergeUrl
}

function readParsedItemFromCache<TItem extends Item>(
  store: ItemsStoreState<TItem>,
  itemId: string,
): TItem | null {
  const documentUrl = toItemDocumentUrl(itemId)
  const handle = findRepoDocHandle<RepoDoc>(store.repo, documentUrl)
  const rawDoc = readReadySnapshot(handle)

  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
    return null
  }

  let parsedByDoc = store.parsedItemsByUrl.get(documentUrl)
  if (!parsedByDoc) {
    parsedByDoc = new WeakMap<object, TItem | null>()
    store.parsedItemsByUrl.set(documentUrl, parsedByDoc)
  }

  const cacheKey = rawDoc as object
  if (parsedByDoc.has(cacheKey)) {
    return parsedByDoc.get(cacheKey) ?? null
  }

  const parsed = parseItemFromDoc(itemId, rawDoc, store.schema)
  parsedByDoc.set(cacheKey, parsed)
  return parsed
}

function syncParsedItemCacheKeys<TItem extends Item>(store: ItemsStoreState<TItem>): void {
  const activeUrls = new Set(store.itemIds.map(toItemDocumentUrl))

  for (const documentUrl of Array.from(store.parsedItemsByUrl.keys())) {
    if (!activeUrls.has(documentUrl)) {
      store.parsedItemsByUrl.delete(documentUrl)
    }
  }
}

function syncItemsSnapshot<TItem extends Item>(store: ItemsStoreState<TItem>): boolean {
  const nextItems: TItem[] = []

  for (const itemId of store.itemIds) {
    const nextItem = readParsedItemFromCache(store, itemId)
    if (nextItem) {
      nextItems.push(nextItem)
    }
  }

  const normalizedSnapshot = nextItems.length > 0 ? nextItems : (EMPTY_ITEMS as TItem[])
  const isUnchanged = (
    normalizedSnapshot.length === store.snapshot.length
    && normalizedSnapshot.every((entry, index) => entry === store.snapshot[index])
  )

  if (isUnchanged) {
    return false
  }

  store.snapshot = normalizedSnapshot
  return true
}

function useAutomergeItemsFromIds<TItem extends Item = Item>(
  itemIds: string[],
  schema?: ItemSchema<TItem>,
): TItem[] {
  const resolvedSchema = resolveItemSchema(schema)
  const repo = useRepo()

  const normalizedItemIds = useMemo(
    () => normalizeItemIds(itemIds),
    [itemIds],
  )

  const store = useMemo((): ItemsStoreState<TItem> => {
    const nextStore: ItemsStoreState<TItem> = {
      repo,
      schema: resolvedSchema,
      itemIds: normalizedItemIds,
      parsedItemsByUrl: new Map<AutomergeUrl, WeakMap<object, TItem | null>>(),
      snapshot: EMPTY_ITEMS as TItem[],
    }

    syncParsedItemCacheKeys(nextStore)
    syncItemsSnapshot(nextStore)
    return nextStore
  }, [normalizedItemIds, repo, resolvedSchema])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (store.itemIds.length === 0) {
        return () => {}
      }

      const cleanups: Array<() => void> = []
      const debounced = createDebouncedNotifier(() => {
        const didChange = syncItemsSnapshot(store)
        if (didChange) {
          onStoreChange()
        }
      }, 50)

      for (const itemId of store.itemIds) {
        const documentUrl = toItemDocumentUrl(itemId)
        const handle = findRepoDocHandle<RepoDoc>(store.repo, documentUrl)
        if (!handle) {
          continue
        }

        handle.on('change', debounced.schedule)
        handle.on('heads-changed', debounced.schedule)
        handle.on('delete', debounced.schedule)

        cleanups.push(() => {
          handle.removeListener('change', debounced.schedule)
          handle.removeListener('heads-changed', debounced.schedule)
          handle.removeListener('delete', debounced.schedule)
        })
      }

      return () => {
        debounced.cancel()

        for (const cleanup of cleanups) {
          cleanup()
        }
      }
    },
    [store],
  )

  const getSnapshot = useCallback(
    (): TItem[] => store.snapshot,
    [store],
  )

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_ITEMS as TItem[],
  )
}

export function useAutomergeItems<TItem extends Item = Item>(schema?: ItemSchema<TItem>): TItem[] {
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

  return useAutomergeItemsFromIds<TItem>(itemIds, schema)
}

export function useAutomergeItemsById<TItem extends Item = Item>(
  itemIds: string[],
  schema?: ItemSchema<TItem>,
): TItem[] {
  return useAutomergeItemsFromIds<TItem>(itemIds, schema)
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

export function useAutomergeMetadataValue<K extends keyof AccountMetadata>(
  key: K,
): AccountMetadata[K]
export function useAutomergeMetadataValue<K extends keyof AccountMetadata>(
  key: K,
  defaultValue: NonNullable<AccountMetadata[K]>,
): NonNullable<AccountMetadata[K]>
export function useAutomergeMetadataValue<K extends keyof AccountMetadata>(
  key: K,
  defaultValue?: AccountMetadata[K],
): AccountMetadata[K] {
  const indexUrl = useMemo(
    () => toAutomergeUrlFromItemId(ACCOUNT_METADATA_DOCUMENT_ID) as AutomergeUrl,
    [],
  )

  const projectMetadataProperty = useCallback(
    (indexDoc: RepoDoc | undefined): AccountMetadata[K] => {
      const parsedIndexDoc = parseWithSchema(indexDoc, automergeIndexDocumentSchema) || undefined
      const metadata = normalizeMetadataFromIndex(parsedIndexDoc)

      return metadata[key] === undefined ? (defaultValue as AccountMetadata[K]) : metadata[key]
    },
    [key, defaultValue],
  )

  const [value] = useOptimizedDocument<RepoDoc, AccountMetadata[K]>(
    indexUrl,
    projectMetadataProperty,
    defaultValue as AccountMetadata[K],
  )

  return value
}
