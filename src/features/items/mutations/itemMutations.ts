import { useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import { CONFLICT_HANDLER_AUTOMERGE_ITEMS, enqueueMutation, processOfflineQueue } from '../../../sync/offlineQueue'
import type { ItemId } from '../../../shared/itemTypes'
import { type Item } from '../../../state/items'
import type { AccountMetadata } from '../../../state/metadata'
import { queryClient } from '../../../api/queryClient'
import { handleVaultError } from '../../../api/runtime'
import { trpc } from '../../../api/trpc'
import { getAccountId } from '../../../api/util'
import { fetchItems } from '../../../api/itemReadService'
import { emitDomainEvent } from '../../../events/domainEvents'
import {
  buildQueuedItemMutationPayload,
  dedupeItemsById,
  serializeMetadataAsBranch,
  updateGroupsForDeletedMembers,
  type MetadataEnvelope,
} from './mutationPayloads'
import { optimisticStoreItemsUpdate } from './mutationCache'
import {
  parseItemIdsMutationInput,
  parseMetadataMutationInput,
  parseStoreItemsMutationInput,
} from './mutationSchemas'

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)
const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)
type SetMetadataMutationInput = AccountMetadata | ((prev: AccountMetadata) => AccountMetadata)

export { optimisticStoreItemsUpdate } from './mutationCache'

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

export async function mutateStoreItems(
  items: Item | Item[],
  options?: {
    baseStateById?: Map<ItemId, Item>
  },
): Promise<Item[]> {
  const current = dedupeItemsById(parseStoreItemsMutationInput(items))

  const queuedMutation = await buildQueuedItemMutationPayload(current)

  if (queuedMutation.mutationType === 'items.put') {
    const baseState = options?.baseStateById?.get(queuedMutation.payload.item)
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
}

export async function mutateDeleteItems(
  itemIds: ItemId | ItemId[],
  options?: {
    allItems?: Item[]
  },
): Promise<ItemId[]> {
  const ids = parseItemIdsMutationInput(itemIds)
  const allItems = options?.allItems || await fetchItems()
  const updates = buildDeletionUpdates(allItems, ids)

  if (updates.length > 0) {
    await mutateStoreItems(updates, {
      baseStateById: new Map(allItems.map(item => [item.id, item])),
    })
  }

  emitDomainEvent({ type: 'data:deleted', domain: 'items', ids })

  return ids
}

export async function mutateSetMetadata(
  metadata: AccountMetadata,
): Promise<AccountMetadata> {
  const nextMetadata = parseMetadataMutationInput(metadata) as AccountMetadata

  const payload = await serializeMetadataAsBranch(nextMetadata)
  await enqueueMutation('accounts.updateMetadata', {
    account: getAccountId(),
    metadata: {
      branches: payload.branches,
    } as MetadataEnvelope,
  })

  void processOfflineQueue()

  return nextMetadata
}

export function useDeleteItemsMutation() {
  const allItemsByMutationInputRef = useRef(new Map<ItemId | ItemId[], Item[]>())

  return useMutation({
    mutationFn: (itemIds: ItemId | ItemId[]) => {
      const allItems = allItemsByMutationInputRef.current.get(itemIds)
      return mutateDeleteItems(itemIds, { allItems })
    },
    onMutate: async itemIds => {
      const ids = parseItemIdsMutationInput(itemIds)

      await queryClient.cancelQueries({ queryKey: itemsQueryKey })
      const previous = queryClient.getQueryData<Item[]>(itemsQueryKey)
      const allItems = previous || await fetchItems()

      allItemsByMutationInputRef.current.set(itemIds, allItems)

      const updates = buildDeletionUpdates(allItems, ids)
      queryClient.setQueryData<Item[]>(itemsQueryKey, old => optimisticStoreItemsUpdate(old, updates))

      return { previous }
    },
    onError: (error, _itemIds, context) => {
      if (context?.previous === undefined) {
        queryClient.removeQueries({ queryKey: itemsQueryKey, exact: true })
      } else {
        queryClient.setQueryData(itemsQueryKey, context.previous)
      }

      handleVaultError(error as Error, 'Failed to delete items')
    },
    onSettled: (_data, _error, itemIds) => {
      allItemsByMutationInputRef.current.delete(itemIds)
    },
  })
}

export function useSetMetadataMutation() {
  const nextMetadataByInputRef = useRef(new WeakMap<object, AccountMetadata>())

  return useMutation({
    mutationFn: (metadataOrUpdater: SetMetadataMutationInput) => {
      const inputKey = metadataOrUpdater as object
      const nextMetadata = nextMetadataByInputRef.current.get(inputKey)
      if (nextMetadata) {
        return mutateSetMetadata(nextMetadata)
      }

      const previousMetadata = queryClient.getQueryData<AccountMetadata>(metadataQueryKey) || {} as AccountMetadata
      return mutateSetMetadata(resolveNextMetadata(metadataOrUpdater, previousMetadata))
    },
    onMutate: async metadataOrUpdater => {
      await queryClient.cancelQueries({ queryKey: metadataQueryKey })

      const previous = queryClient.getQueryData<AccountMetadata>(metadataQueryKey) || {} as AccountMetadata
      const nextMetadata = resolveNextMetadata(metadataOrUpdater, previous)

      nextMetadataByInputRef.current.set(metadataOrUpdater as object, nextMetadata)
      queryClient.setQueryData(metadataQueryKey, nextMetadata)

      return { previous }
    },
    onError: (error, _metadataOrUpdater, context) => {
      queryClient.setQueryData(metadataQueryKey, context?.previous || {} as AccountMetadata)
      handleVaultError(error as Error, 'Failed to save settings')
    },
    onSettled: (_data, _error, metadataOrUpdater) => {
      nextMetadataByInputRef.current.delete(metadataOrUpdater as object)
    },
  })
}

export function useStoreItemsMutation() {
  const baseStateByMutationInputRef = useRef(new WeakMap<object, Map<ItemId, Item>>())

  return useMutation({
    mutationFn: (items: Item | Item[]) => {
      const inputKey = items as object
      const baseStateById = baseStateByMutationInputRef.current.get(inputKey)
      return mutateStoreItems(items, { baseStateById })
    },
    onMutate: async items => {
      const current = dedupeItemsById(parseStoreItemsMutationInput(items))

      await queryClient.cancelQueries({ queryKey: itemsQueryKey })

      const previous = queryClient.getQueryData<Item[]>(itemsQueryKey)
      baseStateByMutationInputRef.current.set(
        items as object,
        new Map((previous || []).map(item => [item.id, item])),
      )

      queryClient.setQueryData<Item[]>(itemsQueryKey, old => optimisticStoreItemsUpdate(old, current))

      return { previous }
    },
    onError: (error, _items, context) => {
      if (context?.previous === undefined) {
        queryClient.removeQueries({ queryKey: itemsQueryKey, exact: true })
      } else {
        queryClient.setQueryData(itemsQueryKey, context.previous)
      }

      handleVaultError(error as Error, 'Failed to save items')
    },
    onSettled: (_data, _error, items) => {
      baseStateByMutationInputRef.current.delete(items as object)
    },
  })
}
