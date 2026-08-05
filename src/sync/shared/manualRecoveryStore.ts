import localforage from 'localforage'

import { runStorageOperation } from '../../utils/storageManager'
import { ItemId } from 'src/shared/schemas/items'


const STORE_NAME = 'manual-recovery-items'

export type ManualRecoveryEntry = {
  id: string
  itemId: ItemId
  reason: string
  createdAt: number
}

const storageInstances = new Map<string, LocalForage>()
const metaStorageInstances = new Map<string, LocalForage>()

function getManualRecoveryStorage(accountId: string) {
  let instance = storageInstances.get(accountId)
  if (!instance) {
    instance = localforage.createInstance({
      name: `FlockVault_ManualRecoveryDB_${accountId}`,
      storeName: STORE_NAME,
    })
    storageInstances.set(accountId, instance)
  }
  return instance
}

function getManualRecoveryMetaStorage(accountId: string) {
  let instance = metaStorageInstances.get(accountId)
  if (!instance) {
    instance = localforage.createInstance({
      name: `FlockVault_ManualRecoveryDB_${accountId}`,
      storeName: 'manual-recovery-metadata',
    })
    metaStorageInstances.set(accountId, instance)
  }
  return instance
}

const migrationPromisesByAccount = new Map<string, Promise<void>>()

export function resetMigrationForTesting(): void {
  migrationPromisesByAccount.clear()
}

export function clearInstancesCacheForTesting(): void {
  storageInstances.clear()
  metaStorageInstances.clear()
}

async function runMigration(accountId: string): Promise<void> {
  const storage = getManualRecoveryStorage(accountId)
  const metaStorage = getManualRecoveryMetaStorage(accountId)
  try {
    const migrated = await metaStorage.getItem<boolean>('__migrated_v2')
    if (migrated) {
      return
    }

    const keys = await storage.keys()
    for (const key of keys) {
      const value = await storage.getItem<ManualRecoveryEntry>(key)
      if (value && typeof value === 'object' && typeof value.itemId === 'string') {
        const newItem: ManualRecoveryEntry = {
          ...value,
          id: value.itemId,
        }
        await storage.setItem(value.itemId, newItem)
        if (key !== value.itemId) {
          await storage.removeItem(key)
        }
      } else {
        await storage.removeItem(key)
      }
    }
    await metaStorage.setItem('__migrated_v2', true)
  } catch (error) {
    console.error('[ManualRecoveryStore] Migration failed', error)
  }
}

async function ensureMigrated(accountId: string): Promise<void> {
  let promise = migrationPromisesByAccount.get(accountId)
  if (!promise) {
    promise = runMigration(accountId)
    migrationPromisesByAccount.set(accountId, promise)
  }
  return promise
}

function sortEntries(left: ManualRecoveryEntry, right: ManualRecoveryEntry): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt - left.createdAt
  }

  return left.id.localeCompare(right.id)
}

export async function readManualRecoveryEntries(accountId: string): Promise<ManualRecoveryEntry[]> {
  if (!accountId) return []
  await ensureMigrated(accountId)
  const entries: ManualRecoveryEntry[] = []
  const storage = getManualRecoveryStorage(accountId)

  await storage.iterate<ManualRecoveryEntry, void>(value => {
    if (
      value
      && typeof value === 'object'
      && typeof value.id === 'string'
      && typeof value.itemId === 'string'
      && typeof value.reason === 'string'
      && typeof value.createdAt === 'number'
    ) {
      entries.push(value)
    }
  })

  entries.sort(sortEntries)
  return entries
}

export async function readManualRecoveryCount(accountId: string): Promise<number> {
  if (!accountId) return 0
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  return storage.length()
}

export async function upsertManualRecoveryEntry(
  accountId: string,
  input: {
    itemId: ItemId
    reason: string
  }
): Promise<ManualRecoveryEntry> {
  if (!accountId) throw new Error('accountId is required')
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  const existing = await storage.getItem<ManualRecoveryEntry>(input.itemId)
  const entry: ManualRecoveryEntry = existing || {
    id: input.itemId,
    itemId: input.itemId,
    reason: input.reason,
    createdAt: Date.now(),
  }

  if (existing) {
    entry.reason = input.reason
    entry.createdAt = Date.now()
  }

  await runStorageOperation(() => storage.setItem(entry.id, entry))
  return entry
}

export async function removeManualRecoveryEntryByItemId(accountId: string, itemId: ItemId): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await storage.removeItem(itemId)
}

export async function removeManualRecoveryEntryById(accountId: string, id: string): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await storage.removeItem(id)
}

export async function clearManualRecoveryEntries(accountId: string): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await storage.clear()
}
