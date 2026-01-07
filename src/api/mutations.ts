import { AccountMetadata } from '../state/account'
import {
  checkProperties,
  GroupItem,
  Item,
  ItemId,
} from '../state/items'
import {
  vaultDelete,
  vaultDeleteMany,
  vaultPut,
  vaultPutMany,
  vaultSetMetadata,
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
    // 1. Calculate Versions and Validate
    const itemArray = Array.isArray(items) ? items : [items]
    const itemsWithVersion = itemArray.map(item => {
      const existing = previousItems?.find(p => p.id === item.id)
      return {
        ...item,
        version: (existing?.version ?? 0) + 1,
      }
    })

    const checkResult = checkProperties(itemsWithVersion)
    if (checkResult.error) {
      throw new Error(checkResult.message)
    }

    // 2. Optimistic Update
    await queryClient.cancelQueries({ queryKey: queryKeys.items })
    queryClient.setQueryData<Item[]>(queryKeys.items, old => {
      if (!old) return itemsWithVersion
      const newItems = [...old]
      for (const item of itemsWithVersion) {
        const index = newItems.findIndex(i => i.id === item.id)
        if (index >= 0) {
          newItems[index] = item
        } else {
          newItems.push(item)
        }
      }
      return newItems
    })

    // 3. Prepare for API
    const vault = await getVaultModule()
    const encrypted = await Promise.all(
      itemsWithVersion.map(item => vault.encryptObject(item)),
    )
    const modifiedTime = new Date().getTime()

    // 4. API Call
    if (itemsWithVersion.length === 1) {
      await vaultPut({
        cipher: encrypted[0].cipher,
        item: itemsWithVersion[0].id,
        metadata: {
          iv: encrypted[0].iv,
          type: itemsWithVersion[0].type,
          modified: modifiedTime,
          version: itemsWithVersion[0].version,
        },
      })
    } else {
      await vaultPutMany({
        items: encrypted.map(({ cipher, iv }, i) => ({
          account: getAccountId(),
          cipher,
          item: itemsWithVersion[i].id,
          metadata: {
            iv,
            type: itemsWithVersion[i].type,
            modified: modifiedTime,
            version: itemsWithVersion[i].version,
          },
        })),
      })
    }

    return itemsWithVersion
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
