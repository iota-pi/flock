import { useMutation } from '@tanstack/react-query'
import type { ItemId } from '../../../shared/itemTypes'
import { type Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import { handleVaultError } from '../../../api/runtime'
import { getAccountId } from '../../../api/util'
import { fetchItems } from '../../../api/itemReadService'
import { emitDomainEvent } from '../../../events/domainEvents'
import { dedupeItemsById, updateGroupsForDeletedMembers } from './mutationPayloads'
import {
  parseItemIdsMutationInput,
  parseMetadataMutationInput,
  parseStoreItemsMutationInput,
} from './mutationSchemas'
import {
  getAutomergeItems,
  initializeAutomergeDocStore,
  upsertAutomergeItemSnapshot,
} from '../../../sync/automergeDocStore'
import { requestAutomergeSync } from '../../../sync/automergeSyncDispatcher'
import { setMetadata as pushMetadata } from '../../../api/vault/client'

type SetMetadataMutationInput = AccountMetadata | ((prev: AccountMetadata) => AccountMetadata)

function resolveNextMetadata(
  metadataOrUpdater: SetMetadataMutationInput,
  previousMetadata: AccountMetadata,
): AccountMetadata {
  const nextMetadata = typeof metadataOrUpdater === 'function'
    ? metadataOrUpdater(previousMetadata)
    : metadataOrUpdater

  return parseMetadataMutationInput(nextMetadata) as AccountMetadata
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
  const current = dedupeItemsById(parseStoreItemsMutationInput(items))
  await ensureAutomergeStoreReady()

  for (const item of current) {
    await upsertAutomergeItemSnapshot(item)
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

  const localItems = options?.allItems ?? getAutomergeItems()
  const allItems = localItems.length > 0
    ? localItems
    : await fetchItems()

  const updates = buildDeletionUpdates(allItems, ids)

  if (updates.length > 0) {
    await mutateStoreItems(updates)
  }

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

export function useDeleteItemsMutation() {
  return useMutation({
    mutationFn: (itemIds: ItemId | ItemId[]) => mutateDeleteItems(itemIds),
    onError: error => {
      handleVaultError(error as Error, 'Failed to delete items')
    },
  })
}

export function useSetMetadataMutation() {
  return useMutation({
    mutationFn: (metadataOrUpdater: SetMetadataMutationInput) => {
      const previousMetadata = {} as AccountMetadata
      return mutateSetMetadata(resolveNextMetadata(metadataOrUpdater, previousMetadata))
    },
    onError: error => {
      handleVaultError(error as Error, 'Failed to save settings')
    },
  })
}

export function useStoreItemsMutation() {
  return useMutation({
    mutationFn: (items: Item | Item[]) => mutateStoreItems(items),
    onError: error => {
      handleVaultError(error as Error, 'Failed to save items')
    },
  })
}
