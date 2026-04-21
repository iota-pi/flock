import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl } from '@automerge/automerge-repo/slim'
import { z } from 'zod'
import { getBlankItem, type Item, type ItemForType } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { accountMetadataSchema } from '../shared/schemas/metadata'
import { ERROR_ITEM_TYPE, ITEM_TYPES, type ItemType } from '../shared/itemTypes'
import { ErrorItem, frequencySchema, noteSchema, readItemSchema } from '../shared/schemas/items'
import { ACCOUNT_METADATA_DOCUMENT_ID } from './automergeDocStore'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { createDebouncedNotifier, normalizeItemIds, parseWithSchema } from './syncUtils'
import { useOptimizedDocument } from './useOptimizedDocument'
import { findRepoDocHandle, readReadyObjectSnapshot } from './automergeHandleUtils'

const EMPTY_ITEMS: Item[] = []
const EMPTY_ITEM_IDS: string[] = []
const EMPTY_METADATA: AccountMetadata = {}


const automergeIndexDocumentSchema = z.looseObject({
  accountId: z.string().optional(),
  itemIds: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
})

let PARSED_ITEM_CACHE = new WeakMap<ItemSchema<Item>, WeakMap<object, unknown>>()

export function clearParsedItemCache(): void {
  PARSED_ITEM_CACHE = new WeakMap<ItemSchema<Item>, WeakMap<object, unknown>>()
}

function getGlobalParsedCache<TItem extends Item>(schema: ItemSchema<TItem>) {
  let schemaCache = PARSED_ITEM_CACHE.get(schema)
  if (!schemaCache) {
    schemaCache = new WeakMap<object, unknown>()
    PARSED_ITEM_CACHE.set(schema, schemaCache)
  }
  return schemaCache as WeakMap<object, TItem | null>
}

type RepoDoc = Record<string, unknown>
type Repo = ReturnType<typeof useRepo>
type AutomergeIndexDocument = z.infer<typeof automergeIndexDocumentSchema>
type ItemSchema<TItem extends Item> = z.ZodType<TItem>
type ItemUpdate<TItem extends Item> = Partial<TItem> | ((prev: TItem) => TItem)


type ItemsStoreState<TItem extends Item> = {
  repo: Repo
  schema: ItemSchema<TItem>
  enableErrorFallback: boolean
  enableLenientRead: boolean
  itemIds: string[]
  snapshot: TItem[]
}

const defaultItemSchema = readItemSchema as ItemSchema<Item>

const lenientBaseItemReadSchema = z.object({
  archived: z.boolean().optional(),
  created: z.number().optional(),
  deleted: z.boolean().optional(),
  description: z.string().optional(),
  id: z.string().optional(),
  isNew: z.literal(true).optional(),
  name: z.string().optional(),
  notes: z.array(noteSchema).optional(),
  prayedFor: z.array(z.number()).optional(),
  prayerFrequency: frequencySchema.optional(),
}).passthrough()

const lenientPersonItemReadSchema = lenientBaseItemReadSchema.extend({
  type: z.literal('person'),
}).passthrough()

const lenientGroupItemReadSchema = lenientBaseItemReadSchema.extend({
  memberPrayerFrequency: frequencySchema.optional(),
  memberPrayerTarget: z.enum(['one', 'all']).optional(),
  members: z.array(z.string()).optional(),
  type: z.literal('group'),
}).passthrough()

const lenientTopicItemReadSchema = lenientBaseItemReadSchema.extend({
  type: z.literal('topic'),
}).passthrough()

const lenientItemReadSchema = z.discriminatedUnion('type', [
  lenientPersonItemReadSchema,
  lenientGroupItemReadSchema,
  lenientTopicItemReadSchema,
])

export type UseAutomergeItemDocumentResult<TItem extends Item> = {
  item: TItem | null
  change: (changeFn: (draft: TItem) => void) => void
}

export type UseAutomergeItemCommandsResult<TItem extends Item> = {
  applyItemUpdate: (
    update: ItemUpdate<TItem>,
  ) => void
}

type ParseItemOptions = {
  enableErrorFallback?: boolean
  enableLenientRead?: boolean
}

function cloneRawSnapshot(value: RepoDoc): RepoDoc {
  return JSON.parse(JSON.stringify(value)) as RepoDoc
}

function normalizeItemType(rawType: unknown): ItemType | undefined {
  if (typeof rawType !== 'string') {
    return undefined
  }

  return ITEM_TYPES.includes(rawType as ItemType)
    ? rawType as ItemType
    : undefined
}

function createErrorItemFallback(
  itemId: string,
  rawSnapshot: RepoDoc,
  errorMessage?: string,
): ErrorItem {
  const originalType = normalizeItemType(rawSnapshot.type)
  const fallbackName = typeof rawSnapshot.name === 'string' && rawSnapshot.name.trim().length > 0
    ? rawSnapshot.name
    : `Corrupted Item (${itemId.slice(0, 8)})`

  const notes = Array.isArray(rawSnapshot.notes)
    ? rawSnapshot.notes.filter(note => !!note && typeof note === 'object')
    : []
  const prayedFor = Array.isArray(rawSnapshot.prayedFor)
    ? rawSnapshot.prayedFor.filter(value => typeof value === 'number')
    : []
  const parsedFrequency = frequencySchema.safeParse(rawSnapshot.prayerFrequency)
  const prayerFrequency = parsedFrequency.success
    ? parsedFrequency.data
    : 'none'

  return {
    archived: typeof rawSnapshot.archived === 'boolean' ? rawSnapshot.archived : false,
    created: typeof rawSnapshot.created === 'number' ? rawSnapshot.created : Date.now(),
    description: typeof rawSnapshot.description === 'string' ? rawSnapshot.description : '',
    id: itemId,
    name: fallbackName,
    notes,
    originalType,
    prayedFor,
    prayerFrequency,
    rawSnapshot: cloneRawSnapshot(rawSnapshot),
    type: ERROR_ITEM_TYPE,
    errorMessage,
  }
}

function parseLenientItemSnapshot(itemId: string, rawSnapshot: RepoDoc): Item | null {
  const lenientParsed = parseWithSchema(rawSnapshot, lenientItemReadSchema)
  if (!lenientParsed) {
    return null
  }

  if (lenientParsed.type === 'group') {
    const blankGroup = getBlankItem('group', false) as ItemForType<'group'>
    return {
      ...blankGroup,
      ...lenientParsed,
      id: itemId,
      members: lenientParsed.members || blankGroup.members,
      memberPrayerFrequency: lenientParsed.memberPrayerFrequency || blankGroup.memberPrayerFrequency,
      memberPrayerTarget: lenientParsed.memberPrayerTarget || blankGroup.memberPrayerTarget,
      type: 'group',
    } as Item
  }

  if (lenientParsed.type === 'person') {
    const blankPerson = getBlankItem('person', false) as ItemForType<'person'>
    return {
      ...blankPerson,
      ...lenientParsed,
      id: itemId,
      type: 'person',
    } as Item
  }

  const blankTopic = getBlankItem('topic', false) as ItemForType<'topic'>
  return {
    ...blankTopic,
    ...lenientParsed,
    id: itemId,
    type: 'topic',
  } as Item
}

function parseItemFromDoc<TItem extends Item>(
  itemId: string,
  rawDoc: unknown,
  schema: ItemSchema<TItem>,
  options: ParseItemOptions = {},
): TItem | null {
  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
    return null
  }

  const snapshot = rawDoc as RepoDoc
  const cacheKey = snapshot as object
  const cache = getGlobalParsedCache(schema)

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) ?? null
  }
  const normalizedItem = (typeof snapshot.id === 'string' && snapshot.id.length > 0)
    ? snapshot
    : { ...snapshot, id: itemId }

  const parsed = parseWithSchema(normalizedItem, schema)
  if (parsed) {
    cache.set(cacheKey, parsed)
    return parsed
  }

  if (options.enableLenientRead) {
    const lenientItem = parseLenientItemSnapshot(itemId, normalizedItem)
    if (lenientItem) {
      cache.set(cacheKey, lenientItem as TItem)
      return lenientItem as TItem
    }
  }

  if (options.enableErrorFallback) {
    const errorItem = createErrorItemFallback(
      itemId,
      normalizedItem,
      `Schema validation failed for item ${itemId}`,
    ) as unknown as TItem
    cache.set(cacheKey, errorItem)
    return errorItem
  }

  cache.set(cacheKey, null)
  return null
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
  const rawDoc = readReadyObjectSnapshot(handle)

  return parseItemFromDoc(itemId, rawDoc, store.schema, {
    enableErrorFallback: store.enableErrorFallback,
    enableLenientRead: store.enableLenientRead,
  })
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
  const resolvedSchema = resolveItemSchema(schema) as ItemSchema<TItem>
  const repo = useRepo()

  const normalizedItemIds = useMemo(
    () => normalizeItemIds(itemIds),
    [itemIds],
  )

  const store = useMemo((): ItemsStoreState<TItem> => {
    const usesDefaultSchema = resolvedSchema === defaultItemSchema

    const nextStore: ItemsStoreState<TItem> = {
      repo,
      schema: resolvedSchema,
      enableErrorFallback: usesDefaultSchema,
      enableLenientRead: usesDefaultSchema,
      itemIds: normalizedItemIds,
      snapshot: EMPTY_ITEMS as TItem[],
    }

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
  const itemIds = useAutomergeItemIds()
  return useAutomergeItemsById<TItem>(itemIds, schema)
}

export function useAutomergeItemIds(): string[] {
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

  return itemIds
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
  const enableFallbacks = resolvedSchema === defaultItemSchema

  const documentUrl = useMemo(
    () => toAutomergeUrlFromItemId(itemId) as AutomergeUrl,
    [itemId],
  )

  const projectItemSnapshot = useCallback(
    (itemDoc: TItem | undefined): TItem | null => parseItemFromDoc(itemId, itemDoc, resolvedSchema, {
      enableErrorFallback: enableFallbacks,
      enableLenientRead: enableFallbacks,
    }),
    [itemId, resolvedSchema, enableFallbacks],
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

export function useAutomergeItemSelector<TSnapshot, TItem extends Item = Item>(
  itemId: string | null | undefined,
  selector: (item: TItem | null) => TSnapshot,
  fallbackSnapshot: TSnapshot,
  schema?: ItemSchema<TItem>,
): TSnapshot {
  const resolvedSchema = resolveItemSchema(schema)
  const enableFallbacks = resolvedSchema === defaultItemSchema

  const documentUrl = useMemo(
    () => (itemId ? toAutomergeUrlFromItemId(itemId) as AutomergeUrl : null),
    [itemId],
  )

  const projectSelectedSnapshot = useCallback(
    (itemDoc: RepoDoc | undefined): TSnapshot => {
      const parsedItem = parseItemFromDoc(itemId || '', itemDoc, resolvedSchema, {
        enableErrorFallback: enableFallbacks,
        enableLenientRead: enableFallbacks,
      })

      return selector(parsedItem)
    },
    [itemId, resolvedSchema, enableFallbacks, selector],
  )

  const [selectedSnapshot] = useOptimizedDocument<RepoDoc, TSnapshot>(
    documentUrl,
    projectSelectedSnapshot,
    fallbackSnapshot,
  )

  return selectedSnapshot
}

export function useAutomergeItemCommands<TItem extends Item = Item>(
  itemId: string,
  schema?: ItemSchema<TItem>,
): UseAutomergeItemCommandsResult<TItem> {
  const resolvedSchema = resolveItemSchema(schema)
  const repo = useRepo()

  const applyItemUpdate = useCallback(
    (
      update: ItemUpdate<TItem>,
    ) => {
      const documentUrl = toAutomergeUrlFromItemId(itemId) as AutomergeUrl
      const handle = findRepoDocHandle<RepoDoc>(repo, documentUrl)

      if (!handle) {
        throw new Error(`Automerge handle missing for item: ${itemId}`)
      }

      if (!handle.isReady()) {
        throw new Error(`Automerge handle not ready for item: ${itemId}`)
      }

      if (handle.isUnavailable()) {
        throw new Error(`Automerge handle unavailable for item: ${itemId}`)
      }

      handle.change(draft => {
        if (typeof draft.id !== 'string' || draft.id.length === 0) {
          draft.id = itemId
        }

        if (typeof update === 'function') {
          const currentDraft = structuredClone(draft) as TItem
          const nextSnapshot = update(currentDraft)
          Object.assign(draft, nextSnapshot)
        } else {
          Object.assign(draft, update)
        }

        const validation = resolvedSchema.safeParse(draft)
        if (!validation.success) {
          throw new Error(`Blocked invalid Automerge item mutation for ${itemId}: ${validation.error.message}`)
        }
      })
    },
    [repo, itemId, resolvedSchema],
  )

  return useMemo(
    () => ({
      applyItemUpdate,
    }),
    [applyItemUpdate],
  )
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
