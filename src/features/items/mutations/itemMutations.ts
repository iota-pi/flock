import type { ItemId } from '../../../shared/itemTypes'
import { GroupItem, ITEM_TYPES, type Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import { getAccountId } from '../../../api/util'
import { ensureItemsBootstrap, setCachedMetadata } from '../../../api/itemReadService'
import { emitDomainEvent } from '../../../events/domainEvents'
import { useNavigationStore } from '../../../state/navigationStore'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  withAutomergeItemChange,
} from '../../../sync/automergeDocStore'
import { requestAutomergeSync } from '../../../sync/automergeSyncDispatcher'
import { setMetadata as pushMetadata } from '../../../api/vault/client'

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

    if (!ITEM_TYPES.includes(item.type)) {
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

export async function mutateStoreItems(
  items: Item | Item[],
): Promise<Item[]> {
  const current = normalizeItemsInput(items)
  await ensureAutomergeStoreReady()

  for (const item of current) {
    await withAutomergeItemChange(item.id, draft => {
      for (const key of Object.keys(draft)) {
        delete draft[key]
      }

      for (const [key, value] of Object.entries(item as unknown as Record<string, unknown>)) {
        if (value !== undefined) {
          draft[key] = value
        }
      }
    })
  }

  requestAutomergeSync(current.map(item => item.id))
  emitDomainEvent({ type: 'data:updated', domain: 'items', reason: 'automerge:local-change' })

  return current
}

export async function mutateDeleteItems(
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
    await mutateStoreItems(updates)
  }

  useNavigationStore.getState().pruneItemDrawers(ids)
  emitDomainEvent({ type: 'data:deleted', domain: 'items', ids })

  return ids
}

export async function mutateSetMetadata(
  metadata: AccountMetadata,
): Promise<AccountMetadata> {
  const nextMetadata = sanitizeMetadata(metadata)
  await pushMetadata(nextMetadata as Record<string, unknown>)
  setCachedMetadata(nextMetadata)
  emitDomainEvent({ type: 'data:updated', domain: 'metadata', reason: 'automerge:metadata-updated' })

  return nextMetadata
}
