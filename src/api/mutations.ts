import { AccountMetadata } from '../state/account'
import {
  checkProperties,
  GroupItem,
  Item,
  ItemId,
  supplyMissingAttributes,
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
import { fetchItems } from './queries'
import { queryClient, queryKeys, handleVaultError } from './client'
import { pruneItems } from '../state/ui'
import store from '../store'

// Helper to avoid circular dependency on Vault.ts for encryption
async function getVaultModule() {
  return import('./Vault')
}

export async function mutateSetMetadata(metadataOrUpdater: AccountMetadata | ((prev: AccountMetadata) => AccountMetadata)) {
  const previousMetadata = queryClient.getQueryData<AccountMetadata>(queryKeys.metadata) ?? {} as AccountMetadata

  try {
    // 1. Calculate new state
    const nextMetadata = typeof metadataOrUpdater === 'function'
      ? metadataOrUpdater(previousMetadata)
      : metadataOrUpdater

    // 2. Optimistic Update
    await queryClient.cancelQueries({ queryKey: queryKeys.metadata })
    queryClient.setQueryData<AccountMetadata>(queryKeys.metadata, nextMetadata)

    // 3. API Call
    const vault = await getVaultModule()
    const { cipher, iv } = await vault.encryptObject(nextMetadata)
    await vaultSetMetadata({ cipher, iv })

    return nextMetadata
  } catch (err) {
    // 4. Rollback on error
    queryClient.setQueryData(queryKeys.metadata, previousMetadata)
    handleVaultError(err as Error, 'Failed to update metadata')
    throw err
  } finally {
    // 5. Invalidate
    queryClient.invalidateQueries({ queryKey: queryKeys.metadata })
  }
}

export async function mutateStoreItems(items: Item | Item[]) {
  const previousItems = queryClient.getQueryData<Item[]>(queryKeys.items)

  try {
    let currentItems = Array.isArray(items) ? [...items] : [items]
    const baseItems = new Map((previousItems || []).map(i => [i.id, i]))
    let attempt = 0
    const MAX_RETRIES = 3

    while (attempt < MAX_RETRIES) {
      attempt++

      // 1. Prepare
      if (attempt === 1) {
        currentItems = prepareItemsForSave(currentItems, baseItems)
      }

      const checkResult = checkProperties(currentItems)
      if (checkResult.error) throw new Error(checkResult.message)

      // 2. Optimistic Update
      await updateCacheOptimistically(currentItems)

      try {
        // 3. Save
        await saveItemsToVault(currentItems)
        return currentItems

      } catch (err) {
        // 4. Handle Conflict
        currentItems = await handleConflict(err, currentItems, baseItems, attempt, MAX_RETRIES)
      }
    }
    throw new Error('Max retries exceeded')
  } catch (err) {
    // 5. Rollback
    if (previousItems) {
      queryClient.setQueryData(queryKeys.items, previousItems)
    }
    handleVaultError(err as Error, 'Failed to store items')
    throw err
  } finally {
    // 6. Invalidate
    await queryClient.invalidateQueries({ queryKey: queryKeys.items })
  }
}

export async function mutateDeleteItems(itemIds: ItemId | ItemId[]) {
  const previousItems = queryClient.getQueryData<Item[]>(queryKeys.items)
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
  const idsSet = new Set(ids)

  try {
    await queryClient.cancelQueries({ queryKey: queryKeys.items })

    // 1. Optimistic Update
    queryClient.setQueryData<Item[]>(queryKeys.items, old => {
      if (!old) return []
      return old
        .filter(item => !idsSet.has(item.id))
        .map(item => {
          if (
            item.type === 'group'
            && (item as GroupItem).members.some(m => idsSet.has(m))
          ) {
            return {
              ...item,
              members: (item as GroupItem).members.filter(m => !idsSet.has(m)),
            }
          }
          return item
        })
    })

    const vault = await getVaultModule()

    // 2. Fetch latest for group logic (Wait, earlier implementation called fetchItems inside mutationFn.
    const allItems = await queryClient.ensureQueryData({
      queryKey: queryKeys.items,
      queryFn: fetchItems,
    })

    // 3. Identify and Update Groups
    const groupsToUpdate = allItems.filter((item): item is GroupItem =>
      item.type === 'group' && item.members.some(mId => idsSet.has(mId))
    )

    if (groupsToUpdate.length > 0) {
      const modifiedGroups = groupsToUpdate.map(g => ({
        ...g,
        members: g.members.filter(mId => !idsSet.has(mId)),
      }))

      const encrypted = await Promise.all(
        modifiedGroups.map(item => vault.encryptObject(item))
      )
      const modifiedTime = new Date().getTime()

      await vaultPutMany({
        items: encrypted.map(({ cipher, iv }, i) => ({
          account: getAccountId(),
          cipher,
          item: modifiedGroups[i].id,
          metadata: {
            iv,
            type: modifiedGroups[i].type,
            modified: modifiedTime,
          },
        })),
      })
    }

    // 4. Delete items
    if (ids.length === 1) {
      await vaultDelete({ item: ids[0] })
    } else {
      await vaultDeleteMany({ items: ids })
    }

    // 5. Store dispatch (Side effect)
    store.dispatch(pruneItems(ids))

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

// Helpers

function prepareItemsForSave(items: Item[], baseItems: Map<string, Item>): Item[] {
  return items.map(item => {
    const existing = baseItems.get(item.id)
    return {
      ...item,
      version: (existing?.version ?? 0) + 1,
    }
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

async function handleConflict(
  err: any,
  currentItems: Item[],
  baseItems: Map<string, Item>,
  attempt: number,
  maxRetries: number
): Promise<Item[]> {
  // Check for version conflict
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

  if (attempt >= maxRetries) throw err

  const vault = await getVaultModule()
  const serverEncrypted = await vaultFetchMany({ ids: conflictIds })

  // Modifying currentItems in place (or rather returning a mutated clone logic)
  // We can treat currentItems as mutable for this calculation or map it.
  const nextItems = [...currentItems]

  for (const encryptedItem of serverEncrypted) {
    if (!encryptedItem.metadata || !encryptedItem.cipher) continue

    const decrypted = await vault.decryptObject({
      cipher: encryptedItem.cipher,
      iv: encryptedItem.metadata.iv
    }) as Item
    const theirs = supplyMissingAttributes(decrypted)
    if (typeof encryptedItem.metadata.version === 'number') {
      theirs.version = encryptedItem.metadata.version
    }

    const id = theirs.id
    const base = baseItems.get(id) || theirs
    const yours = nextItems.find(i => i.id === id)

    if (!yours) continue

    const merged = threeWayMerge(base, theirs, yours)
    merged.version = (theirs.version || 0) + 1

    const idx = nextItems.findIndex(i => i.id === id)
    if (idx >= 0) nextItems[idx] = merged

    // Update base for next iteration
    baseItems.set(id, theirs)
  }

  return nextItems
}
