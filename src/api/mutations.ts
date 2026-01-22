import { AccountMetadata } from '../state/account'
import { VaultItem } from '../shared/apiTypes'
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
} from './VaultAPI'
import { getAccountId } from './util'
import { fetchItems, decryptVaultItems, fetchMetadata } from './queries'
import { queryClient, queryKeys, handleVaultError } from './client'
import { pruneItemDrawers } from '../state/ui'
import store from '../store'

// Helper to avoid circular dependency on Vault.ts for encryption
function getVaultModule() {
  return import('./Vault')
}

export type ConflictResolution<TData, TBase = TData> = {
  next: TData
  base: TBase
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

export async function mutateStoreItems(items: Item | Item[]) {
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
    },
  )
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

    store.dispatch(pruneItemDrawers(ids))

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
  queryClient.setQueryData<Item[]>(queryKeys.items, old => {
    if (!old) return items
    const newItems = [...old]
    for (const item of items) {
      const index = newItems.findIndex(i => i.id === item.id)
      if (index >= 0) {
        newItems[index] = item
      } else {
        newItems.push(item)
      }
    }
    return newItems
  })
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
  let conflictIds: string[] = []

  if (currentItems.length === 1 && err instanceof Error && err.message.includes('Version conflict')) {
    conflictIds = [currentItems[0].id]
  }
  else if (err instanceof VaultBatchError) {
    conflictIds = err.failures
      .filter(f => f.error && f.error.includes('Version conflict'))
      .map(f => f.item)

    if (conflictIds.length === 0) throw err
  } else {
    throw err
  }

  const serverEncrypted = await vaultFetchMany({ ids: conflictIds })
  const serverDecrypted = await decryptVaultItems(serverEncrypted as VaultItem[])

  const nextItems = [...currentItems]

  for (const theirs of serverDecrypted) {
    const id = theirs.id
    const base = nextBase.get(id) || theirs
    const yours = nextItems.find(i => i.id === id)

    if (!yours) continue

    const merged = threeWayMerge(base, theirs, yours)
    merged.version = (theirs.version || 0) + 1

    const idx = nextItems.findIndex(i => i.id === id)
    if (idx >= 0) nextItems[idx] = merged

    nextBase.set(id, theirs)
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
  const isConflict = err.message.includes('ConditionalCheckFailed') || err.message.includes('Version conflict') || err.toString().includes('conditional request failed')

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
  }: {
    queryKey: readonly string[]
    getBaseState: (previous: TData | undefined) => TBase
    calculateNextState: (base: TBase) => TData | Promise<TData>
    performSave: (data: TData) => Promise<TData>
    handleConflict: (err: Error, current: TData, base: TBase) => Promise<{ next: TData; base: TBase }>
    optimisticUpdate?: (data: TData) => void
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
      await queryClient.cancelQueries({ queryKey })
      if (optimisticUpdate) {
        optimisticUpdate(current)
      } else {
        queryClient.setQueryData(queryKey, current)
      }

      try {
        // 3. Save
        return await performSave(current)
      } catch (err) {
        if (!(err instanceof Error)) throw err
        if (attempt >= MAX_RETRIES) throw err

        // 4. Handle Conflict
        const resolved = await handleConflict(err, current, base)
        current = resolved.next
        base = resolved.base
      }
    }
    throw new Error('Max retries exceeded')

  } catch (err) {
    // 5. Rollback
    if (previousState !== undefined) {
      queryClient.setQueryData(queryKey, previousState)
    }
    handleVaultError(err as Error, 'Operation failed')
    throw err
  } finally {
    // 6. Invalidate
    await queryClient.invalidateQueries({ queryKey })
  }
}
