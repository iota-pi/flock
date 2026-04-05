/**
 * @deprecated Prefer generated tRPC hooks from `src/api/trpc.ts` and
 * keep this file only for transitional optimistic/offline orchestration.
 */
import { AccountMetadata } from '../state/metadata'
import {
  checkProperties,
  GroupItem,
  Item,
} from '../state/items'
import type { ItemId } from '../shared/itemTypes'
import {
  getMetadata,
  fetchMany,
  put,
  putMany,
  setMetadata,
  VaultBatchError,
  VaultVersionConflictError,
  type VaultItem,
} from './vault/client'
import * as vaultApi from './vault'
import * as Automerge from '@automerge/automerge'
import { trpcClient } from './trpcClient'
import { getAccountId } from './util'
import { fetchItems } from './itemReadService'
import { queryClient } from './queryClient'
import { handleVaultError } from './runtime'
import { useUiStore } from '../state/uiStore'
import { enqueueMutation, isLikelyNetworkError } from '../sync/offlineQueue'
import { CONFLICT_HANDLER_AUTOMERGE_ITEMS } from '../sync/offlineQueue'
import {
  getCachedAutomergeBinary,
  getCachedMetadataAutomergeBinary,
  setCachedMetadataAutomergeBinary,
} from '../sync/automergeBinaryCache'
import { toBytes } from './vault/crypto'
import { resolveQueueConflictInWorker } from '../workers/decryptionWorkerManager'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from './trpc'

const itemsQueryKey = getQueryKey(trpc.items.fetchMany)
const metadataQueryKey = getQueryKey(trpc.accounts.getMetadata)

function hasVaultKeyAccessor(
  vault: typeof vaultApi,
): vault is typeof vaultApi & { getVaultKey: () => CryptoKey } {
  return Object.prototype.hasOwnProperty.call(vault, 'getVaultKey')
    && typeof (vault as { getVaultKey?: unknown }).getVaultKey === 'function'
}

export type ConflictResolution<TData, TBase = TData> = {
  next: TData
  base: TBase
  skipSave?: boolean
}

type BranchPayload = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}
type MetadataEnvelope = {
  branches?: BranchPayload[]
}

function isVersionConflictErrorMessage(message: string): boolean {
  return message.includes('Version conflict')
}

function extractConflictIdsFromError(err: Error): ItemId[] {
  if (err instanceof VaultVersionConflictError) {
    return err.conflictIds
  }

  if (err instanceof VaultBatchError) {
    return err.failures
      .filter(failure => isVersionConflictErrorMessage(failure.error || ''))
      .map(failure => failure.item)
  }

  const withConflicts = err as Error & { conflicts?: unknown }
  if (Array.isArray(withConflicts.conflicts)) {
    return withConflicts.conflicts.filter((value): value is ItemId => typeof value === 'string')
  }

  return []
}

export async function mutateSetMetadata(metadataOrUpdater: AccountMetadata | ((prev: AccountMetadata) => AccountMetadata)) {
  return mutateWithRetry<AccountMetadata, AccountMetadata>(
    {
      queryKey: metadataQueryKey,
      getBaseState: previous => previous || {} as AccountMetadata,
      calculateNextState: async base => {
        const current = typeof metadataOrUpdater === 'function'
          ? metadataOrUpdater(base)
          : metadataOrUpdater
        return current
      },
      performSave: async current => {
        const serverMetadata = await getMetadata()
        const payload = await serializeMetadataAsBranch(current, serverMetadata as MetadataEnvelope)
        await setMetadata({
          branches: payload.branches,
          _expectedParentVersionId: payload.branches[0]?.parentIds.at(-1),
        })
        return current
      },
      handleConflict: handleMetadataConflict,
    },
  )
}

export async function mutateStoreItems(
  items: Item | Item[],
  options: { externalCacheLifecycle?: boolean } = {},
) {
  const queuedItems = Array.isArray(items) ? items : [items]
  const targetItemId = queuedItems.length === 1 ? queuedItems[0].id : undefined
  const cachedItems = queryClient.getQueryData<Item[]>(itemsQueryKey) || []
  const baseState = targetItemId
    ? cachedItems.find(item => item.id === targetItemId)
    : undefined

  return mutateWithRetry<Item[], Map<ItemId, Item>>(
    {
      queryKey: itemsQueryKey,
      getBaseState: previous => (
        new Map((previous || []).map(i => [i.id, i]))
      ),
      calculateNextState: async () => {
        const dedupedById = new Map<ItemId, Item>()
        const currentItems = Array.isArray(items) ? [...items] : [items]
        for (const item of currentItems) {
          dedupedById.set(item.id, item)
        }
        return Array.from(dedupedById.values())
      },
      performSave: async current => {
        await saveItemsToVault(current)
        return current
      },
      handleConflict: handleItemsConflict,
      optimisticUpdate: current => {
        const fullItems = current.filter(item => (item as Item & { deleted?: boolean }).deleted !== true)
        const checkResult = checkProperties(fullItems)
        if (checkResult.error) throw new Error(checkResult.message)
        updateCacheOptimistically(current)
      },
      offlineMutationMeta: baseState ? { baseState } : undefined,
      externalCacheLifecycle: options.externalCacheLifecycle,
    },
  )
}

export function optimisticStoreItemsUpdate(old: Item[] | undefined, items: Item[]) {
  const oldItems = old || []
  const deletedIds = new Set(
    items
      .filter(item => (item as Item & { deleted?: boolean }).deleted === true)
      .map(item => item.id),
  )

  const incoming = items.filter(item => (item as Item & { deleted?: boolean }).deleted !== true)

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

export async function mutateDeleteItems(itemIds: ItemId | ItemId[]) {
  const previousItems = queryClient.getQueryData<Item[]>(itemsQueryKey)
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
  const idsSet = new Set(ids)

  try {
    await queryClient.cancelQueries({ queryKey: itemsQueryKey })

    // Optimistic Update
    queryClient.setQueryData<Item[]>(itemsQueryKey, old => optimisticDeleteUpdate(old, idsSet))

    // Prefer local cache to build tombstones and related group updates.
    const allItems = previousItems || await fetchItems()
    const groupsToUpdate = updateGroupsForDeletedMembers(allItems, idsSet)
    if (groupsToUpdate.length > 0) {
      await mutateStoreItems(groupsToUpdate)
    }

    const itemsById = new Map(allItems.map(item => [item.id, item]))
    const tombstones: Item[] = ids.flatMap(id => {
      const item = itemsById.get(id)
      if (!item) return []
      return [{
        ...item,
        deleted: true,
      }]
    })

    if (tombstones.length > 0) {
      await mutateStoreItems(tombstones)
    }

    useUiStore.getState().pruneItemDrawers(ids)

    return ids
  } catch (err) {
    if (previousItems) {
      queryClient.setQueryData(itemsQueryKey, previousItems)
    }
    handleVaultError(err as Error, 'Failed to delete items')
    throw err
  } finally {
    await queryClient.invalidateQueries({ queryKey: itemsQueryKey })
  }
}

function removeMembersFromGroup(group: GroupItem, idsSet: Set<ItemId>): GroupItem {
  return {
    ...group,
    members: group.members.filter(m => !idsSet.has(m)),
  }
}

function updateGroupsForDeletedMembers(allItems: Item[], idsSet: Set<ItemId>): GroupItem[] {
  return allItems
    .filter((item): item is GroupItem =>
      item.type === 'group' && item.members.some(mId => idsSet.has(mId))
    )
    .map(g => removeMembersFromGroup(g, idsSet))
}

function optimisticDeleteUpdate(old: Item[] | undefined, idsSet: Set<ItemId>): Item[] {
  if (!old) return []
  return old
    .filter(item => !idsSet.has(item.id) && !(item as Item & { deleted?: boolean }).deleted)
    .map(item => {
      if (
        item.type === 'group'
        && (item as GroupItem).members.some(m => idsSet.has(m))
      ) {
        return removeMembersFromGroup(item as GroupItem, idsSet)
      }
      return item
    })
}

async function updateCacheOptimistically(items: Item[]) {
  await queryClient.cancelQueries({ queryKey: itemsQueryKey })
  queryClient.setQueryData<Item[]>(itemsQueryKey, old => optimisticStoreItemsUpdate(old, items))
}

function getHeadVersionId(item?: VaultItem): string | undefined {
  return item?.branches?.[0]?.versionId
}

async function serializeItemAsBranch(
  item: Item,
  vault: typeof vaultApi,
  currentServerItem?: VaultItem,
): Promise<{ branches: BranchPayload[] }> {
  const cachedBinary = getCachedAutomergeBinary(item.id)
  let encryptedAutomergeDoc: string
  let versionId: string

  if (cachedBinary && hasVaultKeyAccessor(vault)) {
    let doc = Automerge.load(cachedBinary)
    doc = Automerge.change(doc, draft => {
      for (const key of Object.keys(draft as Record<string, unknown>)) {
        delete (draft as Record<string, unknown>)[key]
      }
      Object.assign(draft as Record<string, unknown>, item as unknown as Record<string, unknown>)
    })

    const binary = Automerge.save(doc)
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      vault.getVaultKey(),
      binary as BufferSource,
    )

    const ivHex = Array.from(iv).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const ctHex = Array.from(new Uint8Array(cipher)).map(byte => byte.toString(16).padStart(2, '0')).join('')
    encryptedAutomergeDoc = ivHex + ctHex
    versionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  } else {
    const encrypted = await vault.encryptObjectAsAutomerge(item)
    encryptedAutomergeDoc = encrypted.encryptedAutomergeDoc
    versionId = encrypted.versionId
  }

  const headVersionId = getHeadVersionId(currentServerItem)
  return {
    branches: [{
      encryptedAutomergeDoc,
      versionId,
      parentIds: headVersionId ? [headVersionId] : [],
    }],
  }
}

async function mergeConflictBranchesInWorker(
  itemId: ItemId,
  localBranches: BranchPayload[],
  serverBranches: BranchPayload[],
): Promise<BranchPayload> {
  if (typeof Worker === 'undefined') {
    const parentIds = Array.from(new Set([
      ...localBranches.map(branch => branch.versionId),
      ...serverBranches.map(branch => branch.versionId),
    ]))

    return {
      ...localBranches[0],
      versionId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      parentIds,
    }
  }

  const key = vaultApi.getVaultKey()
  return resolveQueueConflictInWorker({
    key,
    itemId,
    localBranches,
    serverBranches,
  })
}

async function saveItemsToVault(items: Item[]) {
  const vault = vaultApi
  const modifiedTime = new Date().getTime()
  let serverItems: VaultItem[] = []
  try {
    const response = await fetchMany({ ids: items.map(item => item.id) })
    serverItems = response?.items || []
  } catch {
    serverItems = []
  }
  const serverById = new Map(serverItems.map(item => [item.item, item]))

  const payloadItems = await Promise.all(items.map(item => (
    serializeItemAsBranch(item, vault, serverById.get(item.id))
  )))

  if (items.length === 1) {
    const payload = payloadItems[0]
    const item = items[0]
    await put({
      item: item.id,
      branches: payload.branches,
      metadata: {
        iv: '',
        type: item.type,
        modified: modifiedTime,
        deleted: item.deleted,
      },
    } as any)
  } else {
    await putMany({
      items: payloadItems.map((payload, i) => {
        const item = items[i]

        return {
          account: getAccountId(),
          item: item.id,
          branches: payload.branches,
          metadata: {
            iv: '',
            type: item.type,
            modified: modifiedTime,
            deleted: item.deleted,
          },
        }
      }) as any,
    })
  }

}

async function handleItemsConflict(
  err: Error,
  currentItems: Item[],
  baseItems: Map<ItemId, Item>,
): Promise<ConflictResolution<Item[], Map<ItemId, Item>>> {
  const extractedConflictIds = extractConflictIdsFromError(err)
  const conflictIds = extractedConflictIds.length > 0
    ? extractedConflictIds
    : (currentItems.length === 1 && isVersionConflictErrorMessage(err.message || '')
      ? [currentItems[0].id]
      : [])

  if (conflictIds.length === 0) {
    throw err
  }

  const account = getAccountId()
  const vaultModule = vaultApi
  const serverItems = await fetchMany({ ids: conflictIds }).then(result => result.items)
  const serverById = new Map(serverItems.map(item => [item.item, item]))

  const resolutions = await Promise.all(conflictIds.map(async conflictId => {
    const localItem = currentItems.find(item => item.id === conflictId)
    const serverEnvelope = serverById.get(conflictId)
    if (!localItem || !serverEnvelope?.branches || serverEnvelope.branches.length === 0) {
      return null
    }

    const localPayload = await serializeItemAsBranch(localItem, vaultModule, serverEnvelope)
    if (!localPayload.branches || localPayload.branches.length === 0) {
      return null
    }

    const resolvedBranch = await mergeConflictBranchesInWorker(
      conflictId,
      localPayload.branches,
      serverEnvelope.branches,
    )

    return {
      item: conflictId,
      resolvedBranch,
    }
  }))

  const filteredResolutions = resolutions.filter(
    (resolution): resolution is { item: ItemId; resolvedBranch: BranchPayload } => !!resolution,
  )

  if (filteredResolutions.length === 0) {
    throw err
  }

  await trpcClient.items.resolveBranchConflict.mutate({
    account,
    idempotencyKey: typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    resolutions: filteredResolutions,
  })

  return {
    next: currentItems,
    base: new Map(baseItems),
    skipSave: true,
  }
}

async function handleMetadataConflict(
  err: Error,
  current: AccountMetadata,
  _base: AccountMetadata,
): Promise<ConflictResolution<AccountMetadata>> {
  const errorMessage = err.message || ''
  const isConflict = errorMessage.includes('ConditionalCheckFailed') || errorMessage.includes('Version conflict') || errorMessage.includes('conditional request failed')

  if (isConflict) {
    const serverEnvelope = await getMetadata() as MetadataEnvelope
    const localPayload = await serializeMetadataAsBranch(current, serverEnvelope)
    const serverBranches = Array.isArray(serverEnvelope?.branches) ? serverEnvelope.branches : []

    if (serverBranches.length === 0 || localPayload.branches.length === 0) {
      throw err
    }

    const resolvedBranch = await mergeConflictBranchesInWorker(
      '__account_metadata__',
      localPayload.branches,
      serverBranches,
    )

    const metadata = await decodeMetadataFromBranch(resolvedBranch)
    setCachedMetadataAutomergeBinary(metadata.binary)

    return {
      next: metadata.value,
      base: metadata.value,
    }
  }
  throw err
}

async function decodeMetadataFromBranch(branch: BranchPayload): Promise<{ value: AccountMetadata, binary: Uint8Array }> {
  const key = vaultApi.getVaultKey()
  const encryptedDoc = branch.encryptedAutomergeDoc
  const ivHex = encryptedDoc.slice(0, 32)
  const cipherHex = encryptedDoc.slice(32)

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(toBytes(ivHex)) },
    key,
    toBytes(cipherHex),
  )

  const binary = new Uint8Array(decrypted)
  const doc = Automerge.load(binary)
  return {
    value: Automerge.toJS(doc) as AccountMetadata,
    binary,
  }
}

async function serializeMetadataAsBranch(
  metadata: AccountMetadata,
  currentServerMetadata?: MetadataEnvelope,
): Promise<{ branches: BranchPayload[] }> {
  const vault = vaultApi
  const headVersionId = currentServerMetadata?.branches?.[0]?.versionId

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
  if (hasVaultKeyAccessor(vault)) {
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      vault.getVaultKey(),
      binary as BufferSource,
    )
    const ivHex = Array.from(iv).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const ctHex = Array.from(new Uint8Array(cipher)).map(byte => byte.toString(16).padStart(2, '0')).join('')
    encryptedAutomergeDoc = ivHex + ctHex
  } else {
    const encrypted = await (vault as unknown as {
      encryptObjectAsAutomerge: (obj: Record<string, unknown>) => Promise<{ encryptedAutomergeDoc: string }>
    }).encryptObjectAsAutomerge(metadata as unknown as Record<string, unknown>)
    encryptedAutomergeDoc = encrypted.encryptedAutomergeDoc
  }

  return {
    branches: [{
      encryptedAutomergeDoc,
      versionId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      parentIds: headVersionId ? [headVersionId] : [],
    }],
  }
}

/**
 * Generic helper to handle the common flow of:
 * 1. Calculate new state
 * 2. Optimistic update
 * 3. Save to Vault
 * 4. Handle (verify/retry) conflicts on error
 * 5. Rollback on failure
 */
async function mutateWithRetry<TData, TBase>(
  {
    queryKey,
    getBaseState,
    calculateNextState,
    performSave,
    handleConflict,
    optimisticUpdate,
    offlineMutationMeta,
    externalCacheLifecycle = false,
  }: {
    queryKey: ReturnType<typeof getQueryKey>
    getBaseState: (previous: TData | undefined) => TBase
    calculateNextState: (base: TBase) => TData | Promise<TData>
    performSave: (data: TData) => Promise<TData>
    handleConflict: (err: Error, current: TData, base: TBase) => Promise<{ next: TData; base: TBase; skipSave?: boolean }>
    optimisticUpdate?: (data: TData) => void
    offlineMutationMeta?: { baseState?: Item }
    externalCacheLifecycle?: boolean
  },
): Promise<TData> {
  const previousState = queryClient.getQueryData<TData>(queryKey)
  let current: TData | null = null

  try {
    let base = getBaseState(previousState)
    const MAX_RETRIES = 3
    let attempt = 0

    while (attempt < MAX_RETRIES) {
      attempt += 1

      // 1. Calculate / Prepare
      if (attempt === 1) {
        current = await calculateNextState(base)
      }

      if (!current) throw new Error('State calculation failed')

      // 2. Optimistic Update
      if (!externalCacheLifecycle) {
        await queryClient.cancelQueries({ queryKey })
        if (optimisticUpdate) {
          optimisticUpdate(current)
        } else {
          queryClient.setQueryData(queryKey, current)
        }
      }

      try {
        // 3. Save
        return await performSave(current)
      } catch (err) {
        if (!(err instanceof Error)) throw err
        if (attempt >= MAX_RETRIES) throw err

        // 4. Handle Conflict
        const resolved = await handleConflict(err, current, base)
        if (resolved.skipSave) {
          return resolved.next
        }
        current = resolved.next
        base = resolved.base
      }
    }
    throw new Error('Max retries exceeded')

  } catch (err) {
    if (current && isLikelyNetworkError(err)) {
      const queuedMutation = await buildOfflineMutation(queryKey, current)
      if (queuedMutation) {
        const conflictHandlerKey = queuedMutation.mutationType.startsWith('items.')
          ? CONFLICT_HANDLER_AUTOMERGE_ITEMS
          : undefined

        await enqueueMutation(queuedMutation.mutationType, queuedMutation.payload, {
          ...offlineMutationMeta,
          conflictHandlerKey,
        })
      }

      useUiStore.getState().setMessage({
        severity: 'warning',
        message: 'Saved offline. Changes will sync when you reconnect.',
      })

      return current
    }

    // 5. Rollback
    if (!externalCacheLifecycle && previousState !== undefined) {
      queryClient.setQueryData(queryKey, previousState)
    }
    handleVaultError(err as Error, 'Operation failed')
    throw err
  }
}

function sameQueryKey(a: ReturnType<typeof getQueryKey>, b: ReturnType<typeof getQueryKey>): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

async function buildOfflineMutation<TData>(
  queryKey: ReturnType<typeof getQueryKey>,
  current: TData,
): Promise<{ mutationType: string, payload: unknown } | null> {
  if (sameQueryKey(queryKey, itemsQueryKey)) {
    const items = current as unknown as Item[]
    const vault = vaultApi
    const payloadItems = await Promise.all(items.map(item => (
      serializeItemAsBranch(item, vault)
    )))
    const modifiedTime = new Date().getTime()

    if (items.length === 1) {
      const payload = payloadItems[0]
      return {
        mutationType: 'items.put',
        payload: {
          account: getAccountId(),
          item: items[0].id,
          branches: payload.branches,
          modified: modifiedTime,
          type: items[0].type,
          deleted: items[0].deleted,
        },
      }
    }

    return {
      mutationType: 'items.putMany',
      payload: {
        account: getAccountId(),
        items: payloadItems.map((payload, i) => ({
          id: items[i].id,
          branches: payload.branches,
          modified: modifiedTime,
          type: items[i].type,
          deleted: items[i].deleted,
        })),
      },
    }
  }

  if (sameQueryKey(queryKey, metadataQueryKey)) {
    const metadata = current as unknown as AccountMetadata
    const serverMetadata = await getMetadata()
    const payload = await serializeMetadataAsBranch(metadata, serverMetadata as MetadataEnvelope)

    return {
      mutationType: 'accounts.updateMetadata',
      payload: {
        account: getAccountId(),
        metadata: {
          branches: payload.branches,
          _expectedParentVersionId: payload.branches[0]?.parentIds.at(-1),
        },
      },
    }
  }

  return null
}
