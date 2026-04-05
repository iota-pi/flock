import { useMutation } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import { CONFLICT_HANDLER_AUTOMERGE_ITEMS, enqueueMutation, processOfflineQueue } from '../sync/offlineQueue'
import type { ItemId } from '../shared/itemTypes'
import { checkProperties, type Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { queryClient } from './queryClient'
import { handleVaultError } from './runtime'
import { trpc } from './trpc'
import { getAccountId } from './util'
import { fetchItems } from './itemReadService'
import { useNavigationStore } from '../state/navigationStore'
import {
  buildQueuedItemMutationPayload,
  dedupeItemsById,
  serializeMetadataAsBranch,
  updateGroupsForDeletedMembers,
  type MetadataEnvelope,
} from './itemMutationPayloads'
import { optimisticStoreItemsUpdate } from './itemMutationCache'

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)
const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)

export { optimisticStoreItemsUpdate } from './itemMutationCache'

export async function mutateStoreItems(items: Item | Item[]): Promise<Item[]> {
  const current = dedupeItemsById(items)
  const previous = queryClient.getQueryData<Item[]>(itemsQueryKey)
  const previousById = new Map((previous || []).map(item => [item.id, item]))

  const fullItems = current.filter(item => item.deleted !== true)
  const checkResult = checkProperties(fullItems)
  if (checkResult.error) {
    throw new Error(checkResult.message)
  }

  await queryClient.cancelQueries({ queryKey: itemsQueryKey })
  queryClient.setQueryData<Item[]>(itemsQueryKey, old => optimisticStoreItemsUpdate(old, current))

  try {
    const queuedMutation = await buildQueuedItemMutationPayload(current)

    if (queuedMutation.mutationType === 'items.put') {
      const baseState = previousById.get(queuedMutation.payload.item)
      await enqueueMutation(queuedMutation.mutationType, queuedMutation.payload, {
        baseState,
        conflictHandlerKey: CONFLICT_HANDLER_AUTOMERGE_ITEMS,
      })
    } else {
      await enqueueMutation(queuedMutation.mutationType, queuedMutation.payload, {
        conflictHandlerKey: CONFLICT_HANDLER_AUTOMERGE_ITEMS,
      })
    }

    void processOfflineQueue()

    return current
  } catch (error) {
    if (previous === undefined) {
      queryClient.removeQueries({ queryKey: itemsQueryKey, exact: true })
    } else {
      queryClient.setQueryData(itemsQueryKey, previous)
    }

    handleVaultError(error as Error, 'Failed to save items')
    throw error
  }
}

export async function mutateDeleteItems(itemIds: ItemId | ItemId[]): Promise<ItemId[]> {
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
  const idsSet = new Set(ids)
  const previousItems = queryClient.getQueryData<Item[]>(itemsQueryKey)

  try {
    const allItems = previousItems || await fetchItems()
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

    const updates = [...groupsToUpdate, ...tombstones]
    if (updates.length > 0) {
      await mutateStoreItems(updates)
    }

    useNavigationStore.getState().pruneItemDrawers(ids)
    return ids
  } catch (error) {
    handleVaultError(error as Error, 'Failed to delete items')
    throw error
  }
}

export async function mutateSetMetadata(
  metadataOrUpdater: AccountMetadata | ((prev: AccountMetadata) => AccountMetadata),
): Promise<AccountMetadata> {
  const previousMetadata = queryClient.getQueryData<AccountMetadata>(metadataQueryKey) || {} as AccountMetadata
  const nextMetadata = typeof metadataOrUpdater === 'function'
    ? metadataOrUpdater(previousMetadata)
    : metadataOrUpdater

  await queryClient.cancelQueries({ queryKey: metadataQueryKey })
  queryClient.setQueryData(metadataQueryKey, nextMetadata)

  try {
    const payload = await serializeMetadataAsBranch(nextMetadata)
    await enqueueMutation('accounts.updateMetadata', {
      account: getAccountId(),
      metadata: {
        branches: payload.branches,
      } as MetadataEnvelope,
    })

    void processOfflineQueue()
    return nextMetadata
  } catch (error) {
    queryClient.setQueryData(metadataQueryKey, previousMetadata)
    handleVaultError(error as Error, 'Failed to save settings')
    throw error
  }
}

export function useDeleteItemsMutation() {
  return useMutation({
    mutationFn: (itemIds: ItemId | ItemId[]) => mutateDeleteItems(itemIds),
  })
}

export function useSetMetadataMutation() {
  return useMutation({
    mutationFn: (metadataOrUpdater: AccountMetadata | ((prev: AccountMetadata) => AccountMetadata)) => (
      mutateSetMetadata(metadataOrUpdater)
    ),
  })
}

export function useStoreItemsMutation() {
  return useMutation({
    mutationFn: (items: Item | Item[]) => mutateStoreItems(items),
  })
}