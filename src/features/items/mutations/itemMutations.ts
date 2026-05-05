import { getBlankItem, type Item } from '../../../state/items'
import { ERROR_ITEM_TYPE, ITEM_TYPES, ItemId, type ItemType } from '../../../shared/itemTypes'
import type { AccountMetadata } from '../../../state/metadata'
import { useNavigationStore } from '../../../state/navigationStore'
import { accountMetadataSchema } from '../../../shared/schemas/metadata'
import { GroupItem, groupItemSchema, personItemSchema, topicItemSchema } from '../../../shared/schemas/items'
import { SyncBridge } from '../../../sync/SyncBridge'
import { useDataStore } from '../../../state/dataStore'

const stripItemWriteSchema = personItemSchema.strip()
  .or(groupItemSchema.strip())
  .or(topicItemSchema.strip())

const stripMetadataWriteSchema = accountMetadataSchema.strip()

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

    const parsed = stripItemWriteSchema.safeParse(item)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')

      throw new Error(`Invalid item payload for ${item.id}: ${issues}`)
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

  const parsed = stripMetadataWriteSchema.safeParse(metadata)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ')

    throw new Error(`Invalid metadata payload: ${issues}`)
  }

  return metadata
}

type CreateItemOverrides = Partial<Omit<Item, 'id' | 'type'>>

function updateGroupsForDeletedMembers(allItems: Record<ItemId, Item>, idsSet: Set<ItemId>): Item[] {
  return Object.values(allItems)
    .filter(
      (item): item is GroupItem => (
        item.type === 'group'
        && item.members.some(memberId => idsSet.has(memberId))
      )
    )
    .map(group => ({
      ...group,
      members: group.members.filter(memberId => !idsSet.has(memberId)),
    }))
}

function buildDeletionUpdates(allItems: Record<ItemId, Item>, ids: ItemId[]): Item[] {
  const idsSet = new Set(ids)
  const groupsToUpdate = updateGroupsForDeletedMembers(allItems, idsSet)

  const tombstones: Item[] = ids.flatMap(id => {
    const item = allItems[id]
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

export function mutateItem(
  itemId: string,
  changes: Partial<Item>,
): Promise<void> {
  const currentItems = useDataStore.getState().items
  const item = currentItems[itemId] as Item | undefined
  if (!item) {
    throw new Error(`Item not found: ${itemId}`)
  }

  const updatedItem = { ...item, ...changes } as Item

  useDataStore.getState().optimisticUpdateItem(itemId, updatedItem)

  const mutationId = crypto.randomUUID()
  return SyncBridge.mutateItem(mutationId, itemId, changes)
}

export async function storeItems(
  items: Item | Item[],
): Promise<Item[]> {
  const current = normalizeItemsInput(items)

  for (const item of current) {
    useDataStore.getState().optimisticUpdateItem(item.id, item)
  }

  await SyncBridge.storeItems(current)

  return current
}

export async function createItem(
  itemType: ItemType,
  overrides: CreateItemOverrides = {},
): Promise<Item> {
  const baseItem = getBlankItem(itemType, true)
  const nextItem = {
    ...baseItem,
    ...overrides,
    id: baseItem.id,
    type: itemType,
  } as Item

  useDataStore.getState().optimisticUpdateItem(nextItem.id, nextItem)
  await SyncBridge.createItem(nextItem)

  return nextItem
}

export async function deleteItems(
  itemIds: ItemId | ItemId[],
): Promise<ItemId[]> {
  const ids = normalizeItemIds(itemIds)

  const currentItems = useDataStore.getState().items
  const updates = buildDeletionUpdates(currentItems, ids)

  if (updates.length > 0) {
    await storeItems(updates)
  }

  useNavigationStore.getState().closeIfOpen(ids)

  return ids
}

export async function hardDeleteItems(itemIds: ItemId | ItemId[]): Promise<ItemId[]> {
  const ids = normalizeItemIds(itemIds)

  for (const itemId of ids) {
    useDataStore.getState().updateItemFromServer(itemId, null)
  }

  await SyncBridge.hardDeleteItems(ids)
  useNavigationStore.getState().closeIfOpen(ids)
  return ids
}

export async function setMetadata(
  metadata: AccountMetadata | ((previous: AccountMetadata) => AccountMetadata),
): Promise<AccountMetadata> {
  const currentMetadata = useDataStore.getState().metadata
  const nextMetadata = sanitizeMetadata(
    typeof metadata === 'function'
      ? metadata({ ...currentMetadata })
      : metadata,
  )

  useDataStore.getState().updateMetadataFromServer(nextMetadata)
  await SyncBridge.mutateMetadata(nextMetadata)

  return nextMetadata
}
