import { AccountMetadata } from '../state/metadata'
import {
  checkProperties,
  GroupItem,
  Item,
  ItemId,
} from '../state/items'
import { threeWayMerge } from '../utils/merge'
import {
  vaultDelete,
  vaultDeleteMany,
  vaultFetchMany,
  vaultPut,
  vaultPutMany,
  vaultSetMetadata,
  VaultBatchError,
  VaultVersionConflictError,
  type VaultItem,
} from './VaultAPI'
import { getAccountId } from './util'
import { fetchItems, decryptVaultItems, fetchMetadata } from './queries'
import { queryClient, queryKeys } from './queryClient'
import { handleVaultError } from './runtime'
import { useUiStore } from '../state/uiStore'

// Helper to avoid circular dependency on Vault.ts for encryption
function getVaultModule() {
  return import('./Vault')
}

export type ConflictResolution<TData, TBase = TData> = {
  next: TData
  base: TBase
  skipSave?: boolean
}

const latestPutVersionByItemId = new Map<string, number>()

function isVersionConflictErrorMessage(message: string): boolean {
  return message.includes('Version conflict')
}

function isStaleConflict(itemId: string, localVersion?: number): boolean {
  const latestVersion = latestPutVersionByItemId.get(itemId)
  if (latestVersion === undefined || localVersion === undefined) {
    return false
  }
  return localVersion <= latestVersion
}

function stripComparisonMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripComparisonMetadata)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  const metadataKeys = new Set(['version', 'modified', 'dirty', 'isNew'])
  const input = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(input)) {
    if (metadataKeys.has(key)) {
      continue
    }
    result[key] = stripComparisonMetadata(nestedValue)
  }
  return result
}

function areItemsEquivalentIgnoringMetadata(left: Item, right: Item): boolean {
  return JSON.stringify(stripComparisonMetadata(left)) === JSON.stringify(stripComparisonMetadata(right))
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
        const checkResult = checkProperties(current)
        if (checkResult.error) throw new Error(checkResult.message)
        updateCacheOptimistically(current)
      },
      externalCacheLifecycle: options.externalCacheLifecycle,
    },
  )
}

export function optimisticStoreItemsUpdate(old: Item[] | undefined, items: Item[]) {
  if (!old) return items

  const nextItems = [...old]
  for (const item of items) {
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

    // Remove deleted members from groups
    const allItems = await fetchItems()
    const groupsToUpdate = updateGroupsForDeletedMembers(allItems, idsSet)
    if (groupsToUpdate.length > 0) {
      await mutateStoreItems(groupsToUpdate)
    }

    await deleteItemsFromVault(ids)

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
  return items.map(item => {
    const existing = baseItems.get(item.id)
    return {
      ...item,
      version: (existing?.version ?? 0) + 1,
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
    .filter(item => !idsSet.has(item.id))
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

async function saveItemsToVault(items: Item[]) {
  const vault = await getVaultModule()
  const encrypted = await Promise.all(
    items.map(item => vault.encryptObject(item)),
  )
  const modifiedTime = new Date().getTime()

  if (items.length === 1) {
    await vaultPut({
      cipher: encrypted[0].cipher,
      item: items[0].id,
      metadata: {
        iv: encrypted[0].iv,
        type: items[0].type,
        modified: modifiedTime,
        version: items[0].version,
      },
    })
  } else {
    await vaultPutMany({
      items: encrypted.map(({ cipher, iv }, i) => ({
        account: getAccountId(),
        cipher,
        item: items[i].id,
        metadata: {
          iv,
          type: items[i].type,
          modified: modifiedTime,
          version: items[i].version,
        },
      })),
    })
  }

  for (const item of items) {
    if (typeof item.version === 'number') {
      latestPutVersionByItemId.set(item.id, item.version)
    }
  }
}

async function deleteItemsFromVault(ids: string[]) {
  if (ids.length === 1) {
    await vaultDelete({ item: ids[0] })
  } else {
    await vaultDeleteMany({ items: ids })
  }
}

async function handleItemsConflict(
  err: Error,
  currentItems: Item[],
  baseItems: Map<string, Item>,
): Promise<ConflictResolution<Item[], Map<string, Item>>> {
  const nextBase = new Map(baseItems)
  const nextItems = [...currentItems]
  let conflictIds: string[] = []

  const errorMessage = err.message || ''
  if (currentItems.length === 1 && isVersionConflictErrorMessage(errorMessage)) {
    const current = currentItems[0]
    if (isStaleConflict(current.id, current.version)) {
      const latestVersion = latestPutVersionByItemId.get(current.id)
      if (latestVersion !== undefined) {
        nextItems[0] = { ...current, version: latestVersion }
      }
      return {
        next: nextItems,
        base: nextBase,
        skipSave: true,
      }
    }

    conflictIds = [current.id]
  }
  else {
    const extractedConflictIds = extractConflictIdsFromError(err)
    if (extractedConflictIds.length === 0) {
      throw err
    }

    for (const conflictId of extractedConflictIds) {
      const local = currentItems.find(item => item.id === conflictId)
      if (local && isStaleConflict(local.id, local.version)) {
        const latestVersion = latestPutVersionByItemId.get(local.id)
        if (latestVersion !== undefined) {
          const index = nextItems.findIndex(item => item.id === local.id)
          if (index >= 0) {
            nextItems[index] = { ...nextItems[index], version: latestVersion }
          }
        }
        continue
      }

      conflictIds.push(conflictId)
    }

    if (conflictIds.length === 0) {
      return {
        next: nextItems,
        base: nextBase,
        skipSave: true,
      }
    }
  }

  if (conflictIds.length === 0) {
    throw err
  }

  const serverEncrypted = await vaultFetchMany({ ids: conflictIds })
  const serverDecrypted = await decryptVaultItems(serverEncrypted as VaultItem[])
  let hasMeaningfulDifference = false

  for (const theirs of serverDecrypted) {
    const id = theirs.id
    const base = nextBase.get(id) || theirs
    const yours = nextItems.find(i => i.id === id)

    if (!yours) continue

    const equivalent = areItemsEquivalentIgnoringMetadata(theirs, yours)

    if (equivalent) {
      const idx = nextItems.findIndex(i => i.id === id)
      if (idx >= 0) {
        // Keep server version so future writes can continue from latest state.
        nextItems[idx] = { ...yours, version: theirs.version }
      }
      nextBase.set(id, theirs)
      continue
    }

    hasMeaningfulDifference = true

    const merged = threeWayMerge(base, theirs, yours)
    merged.version = (theirs.version || 0) + 1

    const idx = nextItems.findIndex(i => i.id === id)
    if (idx >= 0) nextItems[idx] = merged

    nextBase.set(id, theirs)
  }

  if (!hasMeaningfulDifference) {
    return {
      next: nextItems,
      base: nextBase,
      skipSave: true,
    }
  }

  return {
    next: nextItems,
    base: nextBase,
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

    // Merge
    const merged = threeWayMerge(base, theirs, current)
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
    externalCacheLifecycle = false,
  }: {
    queryKey: readonly string[]
    getBaseState: (previous: TData | undefined) => TBase
    calculateNextState: (base: TBase) => TData | Promise<TData>
    performSave: (data: TData) => Promise<TData>
    handleConflict: (err: Error, current: TData, base: TBase) => Promise<{ next: TData; base: TBase; skipSave?: boolean }>
    optimisticUpdate?: (data: TData) => void
    externalCacheLifecycle?: boolean
  },
): Promise<TData> {
  const previousState = queryClient.getQueryData<TData>(queryKey)

  try {
    let base = getBaseState(previousState)
    let current: TData | null = null
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
    // 5. Rollback
    if (!externalCacheLifecycle && previousState !== undefined) {
      queryClient.setQueryData(queryKey, previousState)
    }
    handleVaultError(err as Error, 'Operation failed')
    throw err
  }
}
