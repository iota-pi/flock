import type { ItemId } from '../../../shared/itemTypes'
import { type Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import { getAccountId } from '../../../api/util'
import { ensureItemsBootstrap } from '../../../api/itemReadService'
import { emitDomainEvent } from '../../../events/domainEvents'
import { useNavigationStore } from '../../../state/navigationStore'
import { dedupeItemsById, updateGroupsForDeletedMembers } from './mutationPayloads'
import {
  parseItemIdsMutationInput,
  parseMetadataMutationInput,
  parseStoreItemsMutationInput,
} from './mutationSchemas'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  withAutomergeItemChange,
} from '../../../sync/automergeDocStore'
import { requestAutomergeSync } from '../../../sync/automergeSyncDispatcher'
import { setMetadata as pushMetadata } from '../../../api/vault/client'

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
  const current = dedupeItemsById(parseStoreItemsMutationInput(items))
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
  const ids = parseItemIdsMutationInput(itemIds)
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
  const nextMetadata = parseMetadataMutationInput(metadata) as AccountMetadata
  await pushMetadata(nextMetadata as Record<string, unknown>)
  emitDomainEvent({ type: 'data:updated', domain: 'metadata', reason: 'automerge:metadata-updated' })

  return nextMetadata
}
