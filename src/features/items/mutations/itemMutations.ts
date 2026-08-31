import { convertItem, getBlankItem, type Item } from 'src/state/items'
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

function updateGroupsRemovingMembers(allItems: Record<ItemId, Item>, idsSet: Set<ItemId>): GroupItem[] {
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
  const groupsToUpdate = updateGroupsRemovingMembers(allItems, idsSet)

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

function revertOptimisticObject<T extends Record<string, unknown>>(
  current: T | undefined,
  previous: T | undefined,
  optimistic: T,
): T | undefined {
  if (!current || !previous) return undefined

  const reverted: Record<string, unknown> = { ...current }
  let needsRevert = false

  const allKeys = new Set([
    ...Object.keys(previous),
    ...Object.keys(optimistic),
  ])

  for (const key of allKeys) {
    if (previous[key] !== optimistic[key]) {
      if (current[key] === optimistic[key]) {
        if (previous[key] === undefined) {
          delete reverted[key]
        } else {
          reverted[key] = previous[key]
        }
        needsRevert = true
      }
    }
  }

  return needsRevert ? (reverted as T) : undefined
}

function applyOptimisticItemUpdate(itemId: ItemId, nextItem: Item): () => void {
  const store = useAppStore.getState()
  const previousItem = store.items[itemId] as Item | undefined

  store.optimisticUpdateItem(itemId, nextItem)

  return () => {
    const currentState = useAppStore.getState().items[itemId]
    if (!previousItem) {
      if (currentState) {
        useAppStore.getState().updateItemsFromServer([{ id: itemId, item: null }])
      }
      return
    }

    const reverted = revertOptimisticObject(currentState, previousItem, nextItem)
    if (reverted) {
      useAppStore.getState().updateItemsFromServer([{ id: itemId, item: reverted }])
    }
  }
}

function applyOptimisticMetadataUpdate(nextMetadata: AccountMetadata): () => void {
  const currentMetadata = useAppStore.getState().metadata
  useAppStore.getState().updateMetadata(nextMetadata)

  return () => {
    const latestMetadata = useAppStore.getState().metadata
    const reverted = revertOptimisticObject(latestMetadata, currentMetadata, nextMetadata)
    if (reverted) {
      useAppStore.getState().updateMetadata(reverted)
    }
  }
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
  const rollback = applyOptimisticItemUpdate(itemId, updatedItem)

  void SyncBridge.mutateItem(itemId, changes).catch(error => {
    console.error('[itemMutations] mutateItem SyncBridge error:', error)
    rollback()
  })

  return Promise.resolve()
}

export async function storeItems(
  items: Item | Item[],
): Promise<Item[]> {
  const current = normalizeItemsInput(items)

  const rollbacks = current.map(item =>
    applyOptimisticItemUpdate(item.id, { ...item, isNew: undefined })
  )

  try {
    await SyncBridge.storeItems(current)
  } catch (error) {
    console.error('[itemMutations] storeItems SyncBridge error:', error)
    rollbacks.forEach(rollback => rollback())
    throw error
  }

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

  const rollback = applyOptimisticItemUpdate(nextItem.id, nextItem)
  void SyncBridge.createItem(nextItem).catch(error => {
    console.error('[itemMutations] createItem SyncBridge error:', error)
    rollback()
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

export async function convertItemType(
  itemId: ItemId,
  newType: ItemType,
): Promise<Item> {
  const currentItems = useAppStore.getState().items
  const item = currentItems[itemId] as Item | undefined
  if (!item) {
    throw new Error(`Item not found: ${itemId}`)
  }

  if (item.type === newType) {
    return item
  }

  const convertedItem = convertItem(item, newType)

  if (newType === 'group') {
    const groupsToUpdate = updateGroupsRemovingMembers(currentItems, new Set([itemId]))
    await storeItems([convertedItem, ...groupsToUpdate])
  } else {
    await storeItems([convertedItem])
  }

  return convertedItem
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

  const rollback = applyOptimisticMetadataUpdate(nextMetadata)

  try {
    await SyncBridge.mutateMetadata(nextMetadata)
  } catch (error) {
    console.error('[itemMutations] setMetadata SyncBridge error:', error)
    rollback()
    throw error
  }

  return nextMetadata
}
