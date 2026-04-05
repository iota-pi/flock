import * as Automerge from '@automerge/automerge'
import { useMutation } from '@tanstack/react-query'
import { getQueryKey } from '@trpc/react-query'
import { CONFLICT_HANDLER_AUTOMERGE_ITEMS, enqueueMutation, processOfflineQueue } from '../sync/offlineQueue'
import type { ItemId } from '../shared/itemTypes'
import { checkProperties, type GroupItem, type Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import { queryClient } from './queryClient'
import { handleVaultError } from './runtime'
import { trpc } from './trpc'
import { getAccountId } from './util'
import * as vaultApi from './vault'
import { type BranchPayload, serializeItemAsBranch } from './vault/serializeItemAsBranch'
import { fetchItems } from './itemReadService'
import { useUiStore } from '../state/uiStore'
import {
  getCachedMetadataAutomergeBinary,
  setCachedMetadataAutomergeBinary,
} from '../sync/automergeBinaryCache'

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)
const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)

type QueuePutPayload = {
  account: string
  item: ItemId
  branches: BranchPayload[]
  modified: number
  type: Item['type']
  deleted?: boolean
}

type QueuePutManyPayload = {
  account: string
  items: Array<{
    id: ItemId
    branches: BranchPayload[]
    modified: number
    type: Item['type']
    deleted?: boolean
  }>
}

type QueuedItemMutationPayload =
  | {
    mutationType: 'items.put'
    payload: QueuePutPayload
  }
  | {
    mutationType: 'items.putMany'
    payload: QueuePutManyPayload
  }

type MetadataEnvelope = {
  branches?: BranchPayload[]
}

function dedupeById(items: Item | Item[]): Item[] {
  const incoming = Array.isArray(items) ? items : [items]
  const deduped = new Map<ItemId, Item>()

  for (const item of incoming) {
    deduped.set(item.id, item)
  }

  return Array.from(deduped.values())
}

async function buildQueuedItemMutationPayload(items: Item[]): Promise<QueuedItemMutationPayload> {
  const modified = Date.now()
  const account = getAccountId()
  const payloadItems = await Promise.all(items.map(async item => {
    const payload = await serializeItemAsBranch(item, vaultApi)

    return {
      id: item.id,
      branches: payload.branches,
      modified,
      type: item.type,
      deleted: item.deleted,
    }
  }))

  if (payloadItems.length === 1) {
    const payload = payloadItems[0]
    return {
      mutationType: 'items.put',
      payload: {
        account,
        item: payload.id,
        branches: payload.branches,
        modified: payload.modified,
        type: payload.type,
        deleted: payload.deleted,
      },
    }
  }

  return {
    mutationType: 'items.putMany',
    payload: {
      account,
      items: payloadItems,
    },
  }
}

function removeMembersFromGroup(group: GroupItem, idsSet: Set<ItemId>): GroupItem {
  return {
    ...group,
    members: group.members.filter(memberId => !idsSet.has(memberId)),
  }
}

function updateGroupsForDeletedMembers(allItems: Item[], idsSet: Set<ItemId>): GroupItem[] {
  return allItems
    .filter((item): item is GroupItem => (
      item.type === 'group' && item.members.some(memberId => idsSet.has(memberId))
    ))
    .map(group => removeMembersFromGroup(group, idsSet))
}

async function serializeMetadataAsBranch(
  metadata: AccountMetadata,
): Promise<{ branches: BranchPayload[] }> {
  const cachedBinary = getCachedMetadataAutomergeBinary()
  let binary: Uint8Array

  if (cachedBinary) {
    let doc = Automerge.load(cachedBinary)
    doc = Automerge.change(doc, draft => {
      for (const key of Object.keys(draft as Record<string, unknown>)) {
        delete (draft as Record<string, unknown>)[key]
      }
      Object.assign(draft as Record<string, unknown>, metadata as unknown as Record<string, unknown>)
    })
    binary = Automerge.save(doc)
  } else {
    const doc = Automerge.from(metadata as unknown as Record<string, unknown>)
    binary = Automerge.save(doc)
  }

  setCachedMetadataAutomergeBinary(binary)

  let encryptedAutomergeDoc: string
  if (Object.prototype.hasOwnProperty.call(vaultApi, 'getVaultKey')
    && typeof (vaultApi as { getVaultKey?: unknown }).getVaultKey === 'function') {
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      (vaultApi as typeof vaultApi & { getVaultKey: () => CryptoKey }).getVaultKey(),
      binary as BufferSource,
    )

    const ivHex = Array.from(iv).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const ctHex = Array.from(new Uint8Array(cipher)).map(byte => byte.toString(16).padStart(2, '0')).join('')
    encryptedAutomergeDoc = ivHex + ctHex
  } else {
    const encrypted = await vaultApi.encryptObjectAsAutomerge(metadata as unknown as Record<string, unknown>)
    encryptedAutomergeDoc = encrypted.encryptedAutomergeDoc
  }

  return {
    branches: [{
      encryptedAutomergeDoc,
      versionId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      parentIds: [],
    }],
  }
}

export function optimisticStoreItemsUpdate(old: Item[] | undefined, items: Item[]) {
  const oldItems = old || []
  const deletedIds = new Set(
    items
      .filter(item => item.deleted === true)
      .map(item => item.id),
  )

  const incoming = items.filter(item => item.deleted !== true)

  const nextItems = oldItems.filter(item => !deletedIds.has(item.id))
  if (nextItems.length === 0 && incoming.length === 0) {
    return []
  }

  for (const item of incoming) {
    const index = nextItems.findIndex(existing => existing.id === item.id)
    if (index >= 0) {
      nextItems[index] = item
    } else {
      nextItems.push(item)
    }
  }

  return nextItems
}

export async function mutateStoreItems(items: Item | Item[]): Promise<Item[]> {
  const current = dedupeById(items)
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

    useUiStore.getState().pruneItemDrawers(ids)
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