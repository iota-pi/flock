import { runStorageOperation } from '../../utils/storageManager'
import { ItemId } from 'src/shared/schemas/items'
import {
  createAccountStore,
  clearAccountStoreInstancesCacheForTesting,
} from './createAccountStore'
import {
  getSyncMetadataStorage,
  SYNC_METADATA_KEYS,
  LEGACY_KEYS,
  clearSyncMetadataInstancesCacheForTesting,
} from '../worker/stores/syncMetadataStorage'

const STORE_NAME = 'manual-recovery-items'

export type ManualRecoveryEntry = {
  id: string
  itemId: ItemId
  reason: string
  createdAt: number
}

function getManualRecoveryStorage(accountId: string) {
  return createAccountStore(STORE_NAME, accountId)
}

function getLegacyManualRecoveryMetaStorage(accountId: string) {
  return createAccountStore('manual-recovery-metadata', accountId)
}

const migrationPromisesByAccount = new Map<string, Promise<void>>()

export function resetMigrationForTesting(): void {
  migrationPromisesByAccount.clear()
}

export function clearInstancesCacheForTesting(): void {
  clearAccountStoreInstancesCacheForTesting()
  clearSyncMetadataInstancesCacheForTesting()
}

async function runMigration(accountId: string): Promise<void> {
  const storage = getManualRecoveryStorage(accountId)
  const metaStorage = getSyncMetadataStorage(accountId)
  try {
    const migrated = await metaStorage.getItem<boolean>(SYNC_METADATA_KEYS.MANUAL_RECOVERY_MIGRATED)
    if (migrated) {
      return
    }

    // Check legacy manual-recovery-metadata store for backward compatibility
    try {
      const legacyMetaStorage = getLegacyManualRecoveryMetaStorage(accountId)
      const legacyMigrated = await legacyMetaStorage.getItem<boolean>(LEGACY_KEYS.MANUAL_RECOVERY_MIGRATED)
      if (legacyMigrated) {
        await runStorageOperation(() => metaStorage.setItem(SYNC_METADATA_KEYS.MANUAL_RECOVERY_MIGRATED, true))
        await runStorageOperation(() => legacyMetaStorage.clear()).catch(() => {})
        return
      }
    } catch {
      // Ignore legacy metadata store lookup errors
    }

    const keys = await storage.keys()
    const entriesByItemId = new Map<ItemId, ManualRecoveryEntry[]>()
    const keysToRemove = new Set<string>()

    for (const key of keys) {
      const value = await storage.getItem<ManualRecoveryEntry>(key)
      if (value && typeof value === 'object' && typeof value.itemId === 'string') {
        const list = entriesByItemId.get(value.itemId) ?? []
        list.push(value)
        entriesByItemId.set(value.itemId, list)
        if (key !== value.itemId) {
          keysToRemove.add(key)
        }
      } else {
        keysToRemove.add(key)
      }
    }

    for (const [itemId, entries] of entriesByItemId.entries()) {
      if (entries.length === 1) {
        const single = entries[0]
        const newItem: ManualRecoveryEntry = {
          ...single,
          id: itemId,
        }
        await runStorageOperation(() => storage.setItem(itemId, newItem))
      } else {
        // Sort chronologically ascending to preserve order of reasons
        entries.sort((a, b) => a.createdAt - b.createdAt)
        const uniqueReasons: string[] = []
        for (const entry of entries) {
          if (entry.reason && typeof entry.reason === 'string') {
            const trimmed = entry.reason.trim()
            if (trimmed && !uniqueReasons.includes(trimmed)) {
              uniqueReasons.push(trimmed)
            }
          }
        }
        const combinedReason = uniqueReasons.join('; ') || 'Manual recovery required'
        const latestCreatedAt = Math.max(...entries.map(e => e.createdAt || 0))

        const mergedEntry: ManualRecoveryEntry = {
          id: itemId,
          itemId,
          reason: combinedReason,
          createdAt: latestCreatedAt > 0 ? latestCreatedAt : Date.now(),
        }
        await runStorageOperation(() => storage.setItem(itemId, mergedEntry))
      }
    }

    for (const key of keysToRemove) {
      await runStorageOperation(() => storage.removeItem(key))
    }

    await runStorageOperation(() => metaStorage.setItem(SYNC_METADATA_KEYS.MANUAL_RECOVERY_MIGRATED, true))

    // Clean up legacy metadata store if it exists
    try {
      const legacyMetaStorage = getLegacyManualRecoveryMetaStorage(accountId)
      await runStorageOperation(() => legacyMetaStorage.clear()).catch(() => {})
    } catch {
      // Ignore cleanup error
    }
  } catch (error) {
    console.error('[ManualRecoveryStore] Migration failed', error)
    throw error
  }
}

async function ensureMigrated(accountId: string): Promise<void> {
  let promise = migrationPromisesByAccount.get(accountId)
  if (!promise) {
    promise = runMigration(accountId).catch(error => {
      migrationPromisesByAccount.delete(accountId)
      throw error
    })
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
  await runStorageOperation(() => storage.removeItem(itemId))
}

export async function removeManualRecoveryEntryById(accountId: string, id: string): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await runStorageOperation(() => storage.removeItem(id))
}

export async function clearManualRecoveryEntries(accountId: string): Promise<void> {
  if (!accountId) return
  await ensureMigrated(accountId)
  const storage = getManualRecoveryStorage(accountId)
  await runStorageOperation(() => storage.clear())
}
