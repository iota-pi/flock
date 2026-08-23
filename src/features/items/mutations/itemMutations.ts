import { getBlankItem, type Item } from 'src/state/items'
import type { ItemType } from 'src/shared/itemTypes'
import { ERROR_ITEM_TYPE, ITEM_TYPES, type ItemId, GroupItem, groupItemSchema, personItemSchema, topicItemSchema } from 'src/shared/schemas/items'
import type { AccountMetadata } from 'src/state/metadata'
import { useAppStore } from 'src/state/store'
import { accountMetadataSchema } from 'src/shared/schemas/metadata'
import { SyncBridge } from 'src/sync/client/SyncBridge'


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
    .map(id => id.trim() as ItemId)
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
  itemId: ItemId,
  changes: Partial<Item>,
): Promise<void> {
  const currentItems = useAppStore.getState().items
  const item = currentItems[itemId] as Item | undefined
  if (!item) {
    throw new Error(`Item not found: ${itemId}`)
  }
  if (item.isNew) {
    changes = { ...changes, isNew: undefined }
  }

  const updatedItem = { ...item, ...changes } as Item

  useAppStore.getState().optimisticUpdateItem(itemId, updatedItem)

  void SyncBridge.mutateItem(itemId, changes).catch(error => {
    console.error('[itemMutations] mutateItem SyncBridge error:', error)
  })

  return Promise.resolve()
}

export async function storeItems(
  items: Item | Item[],
): Promise<Item[]> {
  const current = normalizeItemsInput(items)

  for (const item of current) {
    const newItem: Item = { ...item, isNew: undefined }
    useAppStore.getState().optimisticUpdateItem(item.id, newItem)
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

  useAppStore.getState().optimisticUpdateItem(nextItem.id, nextItem)
  void SyncBridge.createItem(nextItem).catch(error => {
    console.error(error)
  })

  return nextItem
}

export async function deleteItems(
  itemIds: ItemId | ItemId[],
): Promise<ItemId[]> {
  const ids = normalizeItemIds(itemIds)

  const currentItems = useAppStore.getState().items
  const updates = buildDeletionUpdates(currentItems, ids)

  if (updates.length > 0) {
    await storeItems(updates)
  }

  useAppStore.getState().closeIfOpen(ids)

  return ids
}

export async function setMetadata(
  metadata: AccountMetadata | ((previous: AccountMetadata) => AccountMetadata),
): Promise<AccountMetadata> {
  const currentMetadata = useAppStore.getState().metadata
  const nextMetadata = sanitizeMetadata(
    typeof metadata === 'function'
      ? metadata({ ...currentMetadata })
      : metadata,
  )

  useAppStore.getState().updateMetadataFromServer(nextMetadata)
  await SyncBridge.mutateMetadata(nextMetadata)

  return nextMetadata
}
