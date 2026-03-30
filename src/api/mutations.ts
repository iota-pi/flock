import { AccountMetadata } from '../state/metadata'
import {
  checkProperties,
  GroupItem,
  Item,
  ItemId,
} from '../state/items'
import { mergeFromBaseWithAutomerge } from '../utils/automergeMerge'
import {
  vaultFetchMany,
  vaultPut,
  vaultPutMany,
  vaultSetMetadata,
  VaultBatchError,
  VaultVersionConflictError,
  type VaultItem,
} from './VaultAPI'
import { trpcClient } from './trpcClient'
import { getAccountId } from './util'
import { fetchItems, fetchMetadata, getCachedAutomergeBinary } from './queries'
import { queryClient, queryKeys } from './queryClient'
import { handleVaultError } from './runtime'
import { useUiStore } from '../state/uiStore'
import { enqueueMutation, isLikelyNetworkError } from './offlineQueue'

// Helper to avoid circular dependency on Vault.ts for encryption
function getVaultModule() {
  return import('./Vault')
}

export type ConflictResolution<TData, TBase = TData> = {
  next: TData
  base: TBase
  skipSave?: boolean
}

type TombstoneItem = Pick<Item, 'id' | 'type' | 'version' | 'deleted'> & { deleted: true }
type BranchPayload = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

function isVersionConflictErrorMessage(message: string): boolean {
  return message.includes('Version conflict')
}

function extractConflictIdsFromError(err: Error): string[] {
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
    return withConflicts.conflicts.filter((value): value is string => typeof value === 'string')
  }

  return []
}

export async function mutateSetMetadata(metadataOrUpdater: AccountMetadata | ((prev: AccountMetadata) => AccountMetadata)) {
  return mutateWithRetry<AccountMetadata, AccountMetadata>(
    {
      queryKey: queryKeys.metadata,
      getBaseState: previous => previous || {} as AccountMetadata,
      calculateNextState: async base => {
        const current = typeof metadataOrUpdater === 'function'
          ? metadataOrUpdater(base)
          : metadataOrUpdater
        current.version = (base.version || 0) + 1
        return current
      },
      performSave: async current => {
        const vault = await getVaultModule()
        const { cipher, iv } = await vault.encryptObject(current)
        await vaultSetMetadata({ cipher, iv, version: current.version })
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
  const cachedItems = queryClient.getQueryData<Item[]>(queryKeys.items) || []
  const baseState = targetItemId
    ? cachedItems.find(item => item.id === targetItemId)
    : undefined

  return mutateWithRetry<Item[], Map<string, Item>>(
    {
      queryKey: queryKeys.items,
      getBaseState: previous => (
        new Map((previous || []).map(i => [i.id, i]))
      ),
      calculateNextState: async base => {
        const currentItems = Array.isArray(items) ? [...items] : [items]
        return prepareItemsForSave(currentItems, base)
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
  const previousItems = queryClient.getQueryData<Item[]>(queryKeys.items)
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
  const idsSet = new Set(ids)

  try {
    await queryClient.cancelQueries({ queryKey: queryKeys.items })

    // Optimistic Update
    queryClient.setQueryData<Item[]>(queryKeys.items, old => optimisticDeleteUpdate(old, idsSet))

    // Prefer local cache to build tombstones and related group updates.
    const allItems = previousItems || await fetchItems()
    const groupsToUpdate = updateGroupsForDeletedMembers(allItems, idsSet)
    if (groupsToUpdate.length > 0) {
      await mutateStoreItems(groupsToUpdate)
    }

    const itemsById = new Map(allItems.map(item => [item.id, item]))
    const tombstones: TombstoneItem[] = ids.flatMap(id => {
      const item = itemsById.get(id)
      if (!item) return []
      return [{
        id: item.id,
        type: item.type,
        deleted: true,
        version: (item.version || 0) + 1,
      }]
    })

    if (tombstones.length > 0) {
      await mutateStoreItems(tombstones as Item[])
    }

    useUiStore.getState().pruneItemDrawers(ids)

    return ids
  } catch (err) {
    if (previousItems) {
      queryClient.setQueryData(queryKeys.items, previousItems)
    }
    handleVaultError(err as Error, 'Failed to delete items')
    throw err
  } finally {
    await queryClient.invalidateQueries({ queryKey: queryKeys.items })
  }
}

function prepareItemsForSave(items: Item[], baseItems: Map<string, Item>): Item[] {
  const dedupedById = new Map<string, Item>()
  for (const item of items) {
    dedupedById.set(item.id, item)
  }

  return Array.from(dedupedById.values()).map(item => {
    const existing = baseItems.get(item.id)
    const baseVersion = existing?.version
      ?? ((item as Item & { deleted?: boolean }).deleted ? (item.version ?? 0) : 0)
    const providedVersion = typeof item.version === 'number' ? item.version : 0
    const isDeleted = (item as Item & { deleted?: boolean }).deleted === true
    const nextVersion = isDeleted && providedVersion >= baseVersion
      ? providedVersion
      : baseVersion + 1

    return {
      ...item,
      version: nextVersion,
    }
  })
}

function removeMembersFromGroup(group: GroupItem, idsSet: Set<string>): GroupItem {
  return {
    ...group,
    members: group.members.filter(m => !idsSet.has(m)),
  }
}

function updateGroupsForDeletedMembers(allItems: Item[], idsSet: Set<string>): GroupItem[] {
  return allItems
    .filter((item): item is GroupItem =>
      item.type === 'group' && item.members.some(mId => idsSet.has(mId))
    )
    .map(g => removeMembersFromGroup(g, idsSet))
}

function optimisticDeleteUpdate(old: Item[] | undefined, idsSet: Set<string>): Item[] {
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
  await queryClient.cancelQueries({ queryKey: queryKeys.items })
  queryClient.setQueryData<Item[]>(queryKeys.items, old => optimisticStoreItemsUpdate(old, items))
}

function getHeadVersionId(item?: VaultItem): string | undefined {
  return item?.branches?.[0]?.versionId
}

async function serializeItemAsBranch(
  item: Item,
  vault: typeof import('./Vault'),
  currentServerItem?: VaultItem,
): Promise<{ branches: BranchPayload[] }> {
  if (item.deleted) {
    return {
      // Tombstones do not require encrypted payload bytes.
      branches: [],
    }
  }

  const cachedBinary = getCachedAutomergeBinary(item.id)
  let encryptedAutomergeDoc: string
  let versionId: string

  if (cachedBinary) {
    const Automerge = await import('@automerge/automerge')
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
  itemId: string,
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

  const key = (await getVaultModule()).getVaultKey()
  const worker = new Worker(new URL('../workers/decryption.worker.ts', import.meta.url), {
    type: 'module',
  })

  const jobId = Date.now() + Math.floor(Math.random() * 1000)

  return new Promise<BranchPayload>((resolve, reject) => {
    worker.onmessage = event => {
      const payload = event.data as {
        type?: string
        jobId?: number
        itemId?: string
        resolvedBranch?: BranchPayload
      }

      if (
        payload.type === 'QUEUE_CONFLICT_RESOLVED'
        && payload.jobId === jobId
        && payload.itemId === itemId
        && payload.resolvedBranch
      ) {
        worker.terminate()
        resolve(payload.resolvedBranch)
      }
    }

    worker.onerror = error => {
      worker.terminate()
      reject(error)
    }

    worker.postMessage({
      type: 'RESOLVE_QUEUE_CONFLICT',
      jobId,
      key,
      itemId,
      localBranches,
      serverBranches,
    })
  })
}

async function saveItemsToVault(items: Item[]) {
  const vault = await getVaultModule()
  const modifiedTime = new Date().getTime()
  let serverItems: VaultItem[] = []
  try {
    const response = await vaultFetchMany({ ids: items.map(item => item.id) })
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
    await vaultPut({
      item: item.id,
      branches: payload.branches,
      metadata: {
        iv: '',
        type: item.type,
        modified: modifiedTime,
        version: item.version,
        deleted: item.deleted,
      },
    } as any)
  } else {
    await vaultPutMany({
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
            version: item.version,
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
  baseItems: Map<string, Item>,
): Promise<ConflictResolution<Item[], Map<string, Item>>> {
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
  const vaultModule = await getVaultModule()
  const serverItems = await vaultFetchMany({ ids: conflictIds }).then(result => result.items)
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
    (resolution): resolution is { item: string; resolvedBranch: BranchPayload } => !!resolution,
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
  base: AccountMetadata,
): Promise<ConflictResolution<AccountMetadata>> {
  const errorMessage = err.message || ''
  const isConflict = errorMessage.includes('ConditionalCheckFailed') || errorMessage.includes('Version conflict') || errorMessage.includes('conditional request failed')

  if (isConflict) {
    // Fetch latest metadata
    const theirs = await fetchMetadata()

    const merged = await mergeFromBaseWithAutomerge(base, theirs, current) as AccountMetadata
    merged.version = (theirs.version || 0) + 1

    // Return new state to retry with
    return {
      next: merged,
      base: theirs
    }
  }
  throw err
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
    queryKey: readonly string[]
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
        await enqueueMutation(queuedMutation.mutationType, queuedMutation.payload, offlineMutationMeta)
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

function sameQueryKey(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index])
}

async function buildOfflineMutation<TData>(
  queryKey: readonly string[],
  current: TData,
): Promise<{ mutationType: string, payload: unknown } | null> {
  if (sameQueryKey(queryKey, queryKeys.items)) {
    const items = current as unknown as Item[]
    const vault = await getVaultModule()
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
          iv: '',
          modified: modifiedTime,
          type: items[0].type,
          version: items[0].version,
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
          iv: '',
          modified: modifiedTime,
          type: items[i].type,
          version: items[i].version,
          deleted: items[i].deleted,
        })),
      },
    }
  }

  if (sameQueryKey(queryKey, queryKeys.metadata)) {
    const metadata = current as unknown as AccountMetadata
    const vault = await getVaultModule()
    const encrypted = await vault.encryptObject(metadata)

    return {
      mutationType: 'accounts.updateMetadata',
      payload: {
        account: getAccountId(),
        metadata: {
          cipher: encrypted.cipher,
          iv: encrypted.iv,
          version: metadata.version,
        },
      },
    }
  }

  return null
}
