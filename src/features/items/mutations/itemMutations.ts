import { ERROR_ITEM_TYPE, GroupItem, type Item } from '../../../state/items'
import { ITEM_TYPES, ItemId } from '../../../shared/itemTypes'
import type { AccountMetadata } from '../../../state/metadata'
import { getAccountId } from '../../../api/util'
import { ensureItemsBootstrap } from '../../../api/itemReadService'
import { useNavigationStore } from '../../../state/navigationStore'
import {
  withAutomergeMetadataChange,
  getAutomergeItems,
  getAutomergeMetadata,
  initializeAutomergeDocStore,
  removeAutomergeItem,
  withAutomergeDocumentChange,
} from '../../../sync/automergeDocStore'

function normalizeItemsInput(items: Item | Item[]): Item[] {
  const incoming = Array.isArray(items) ? items : [items]
  if (incoming.length === 0) {
    throw new Error('Expected at least one item')
  }

  const deduped = new Map<ItemId, Item>()
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) {
      throw new Error('Invalid item: missing id')
    }

    if (item.type === ERROR_ITEM_TYPE || !ITEM_TYPES.includes(item.type)) {
      throw new Error(`Invalid item: unsupported type ${String(item.type)}`)
    }

    deduped.set(item.id, item)
  }

  return Array.from(deduped.values())
}

function normalizeItemIds(itemIds: ItemId | ItemId[]): ItemId[] {
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
  const normalized = ids
    .filter(id => typeof id === 'string')
    .map(id => id.trim())
    .filter(id => id.length > 0)

  if (normalized.length === 0) {
    throw new Error('Expected at least one item id')
  }

  return Array.from(new Set(normalized))
}

function sanitizeMetadata(metadata: AccountMetadata): AccountMetadata {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid metadata payload')
  }

  return metadata
}

function normalizeItemForAutomerge(item: Item): Record<string, unknown> {
  return JSON.parse(JSON.stringify(item)) as Record<string, unknown>
}

function normalizeMetadataForAutomerge(metadata: AccountMetadata): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metadata || {})) as Record<string, unknown>
}

function mutateDraftToMatchSnapshot(
  draft: Record<string, unknown>,
  next: Record<string, unknown>,
): void {
  for (const key of Object.keys(draft)) {
    if (!(key in next) || next[key] === undefined) {
      delete draft[key]
    }
  }

  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) {
      draft[key] = value
    }
  }
}

function updateGroupsForDeletedMembers(allItems: Item[], idsSet: Set<ItemId>): Item[] {
  return allItems
    .filter((item): item is GroupItem => item.type === 'group' && item.members.some(memberId => idsSet.has(memberId)))
    .map(group => ({
      ...group,
      members: group.members.filter(memberId => !idsSet.has(memberId)),
    }))
}

function buildDeletionUpdates(allItems: Item[], ids: ItemId[]): Item[] {
  const idsSet = new Set(ids)
  const groupsToUpdate = updateGroupsForDeletedMembers(allItems, idsSet)
  const itemsById = new Map(allItems.map(item => [item.id, item]))

  const tombstones: Item[] = ids.flatMap(id => {
    const item = itemsById.get(id)
    if (!item) {
      return []
    }

    return [{
      ...item,
      deleted: true,
    }]
  })

  return [...groupsToUpdate, ...tombstones]
}

async function ensureAutomergeStoreReady(): Promise<void> {
  await initializeAutomergeDocStore(getAccountId())
}

let metadataUpdateQueue: Promise<void> = Promise.resolve()

function enqueueMetadataUpdate(task: () => Promise<AccountMetadata>): Promise<AccountMetadata> {
  const operation = metadataUpdateQueue.then(task)
  metadataUpdateQueue = operation.then(
    () => undefined,
    () => undefined,
  )

  return operation
}

export async function storeItems(
  items: Item | Item[],
): Promise<Item[]> {
  const current = normalizeItemsInput(items)
  await ensureAutomergeStoreReady()

  for (const item of current) {
    const normalizedItem = normalizeItemForAutomerge(item)
    await withAutomergeDocumentChange(
      item.id,
      doc => {
        mutateDraftToMatchSnapshot(doc, normalizedItem)

        if (typeof doc.id !== 'string' || doc.id.length === 0) {
          doc.id = item.id
        }
      },
      {
        createIfMissing: true,
        initialValue: { id: item.id },
      },
    )
  }

  return current
}

export async function deleteItems(
  itemIds: ItemId | ItemId[],
  options?: {
    allItems?: Item[]
  },
): Promise<ItemId[]> {
  const ids = normalizeItemIds(itemIds)
  await ensureAutomergeStoreReady()

  let allItems = options?.allItems ?? getAutomergeItems()
  if (allItems.length === 0) {
    await ensureItemsBootstrap(getAccountId(), { force: true })
    allItems = getAutomergeItems()
  }

  const updates = buildDeletionUpdates(allItems, ids)

  if (updates.length > 0) {
    await storeItems(updates)
  }

  useNavigationStore.getState().pruneItemDrawers(ids)

  return ids
}

export async function hardDeleteItems(itemIds: ItemId | ItemId[]): Promise<ItemId[]> {
  const ids = normalizeItemIds(itemIds)
  await ensureAutomergeStoreReady()

  for (const itemId of ids) {
    await removeAutomergeItem(itemId)
  }

  useNavigationStore.getState().pruneItemDrawers(ids)
  return ids
}

export async function setMetadata(
  metadata: AccountMetadata | ((previous: AccountMetadata) => AccountMetadata),
): Promise<AccountMetadata> {
  return enqueueMetadataUpdate(async () => {
    await ensureAutomergeStoreReady()

    const currentMetadata = getAutomergeMetadata() as AccountMetadata
    const nextMetadata = sanitizeMetadata(
      typeof metadata === 'function'
        ? (metadata as (previous: AccountMetadata) => AccountMetadata)({
          ...currentMetadata,
        })
        : metadata,
    )

    const normalizedMetadata = normalizeMetadataForAutomerge(nextMetadata)

    await withAutomergeMetadataChange(metadataDraft => {
      mutateDraftToMatchSnapshot(metadataDraft, normalizedMetadata)
    })

    return nextMetadata
  })
}
