import localforage from 'localforage'

import { runStorageOperation } from '../utils/storageManager'
import { ItemId } from 'src/shared/schemas/items'


const STORE_NAME = 'scheduled-deletions'

export type ScheduledDeletion = {
  accountId: string
  itemId: ItemId
  scheduledTime: number
}

const scheduledDeletionsStorage = localforage.createInstance({
  name: 'FlockVault_DeletionQueueDB',
  storeName: STORE_NAME,
})

export async function scheduleDeletion(
  accountId: string,
  itemId: ItemId,
  gracePeriodMs: number
): Promise<void> {
  const key = `${accountId}:${itemId}`
  const entry: ScheduledDeletion = {
    accountId,
    itemId,
    scheduledTime: Date.now() + gracePeriodMs,
  }

  await runStorageOperation(() => scheduledDeletionsStorage.setItem(key, entry))
}

export async function cancelDeletion(accountId: string, itemId: ItemId): Promise<void> {
  const key = `${accountId}:${itemId}`
  await scheduledDeletionsStorage.removeItem(key)
}

export async function listScheduledDeletions(accountId: string): Promise<ScheduledDeletion[]> {
  const entries: ScheduledDeletion[] = []

  await scheduledDeletionsStorage.iterate<ScheduledDeletion, void>((value, key) => {
    if (key.startsWith(`${accountId}:`) && value) {
      entries.push(value)
    }
  })

  return entries
}

export async function clearScheduledDeletions(accountId: string): Promise<void> {
  const keys: string[] = []

  await scheduledDeletionsStorage.iterate<ScheduledDeletion, void>((value, key) => {
    if (key.startsWith(`${accountId}:`)) {
      keys.push(key)
    }
  })

  await Promise.all(keys.map(key => scheduledDeletionsStorage.removeItem(key)))
}
