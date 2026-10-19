import localforage from 'localforage'
import type { ItemId } from '@vault/shared'
import {
  createAccountStore,
  getAccountDatabaseName,
  runStorageOperation,
  getSyncMetadataStorage,
  SYNC_METADATA_KEYS,
  databaseExists,
} from '@vault/client/worker'
import type { PersistedSyncCursors, ItemSyncTimestamps } from '@vault/client/worker'

/**
 * Brings a device's local sync metadata from Flock's older layouts into the current one:
 * - the per-store databases used until the sync metadata database was consolidated (2026-09-14)
 * - the keys the consolidated database first used
 * - cursor arrays and numeric `lastModified` entries
 * - the `manual-recovery-metadata` store and duplicate manual recovery entries
 *
 * A value is copied only when the current key is missing, and the old one is removed only after
 * that, so running it again (or in two tabs) is harmless.
 */

const MANUAL_RECOVERY_STORE = 'manual-recovery-items'
const LEGACY_MANUAL_RECOVERY_META_STORE = 'manual-recovery-metadata'
/** Set once manual recovery entries are keyed by item ID with one entry per item */
const MANUAL_RECOVERY_MIGRATED_KEY = 'manualRecoveryMigrated'
const LEGACY_MANUAL_RECOVERY_MIGRATED_KEY = '__migrated_v2'

interface LegacyDatabase {
  name: string
  storePrefix: string
  key: string
}

interface LegacyMetadataValue {
  key: string
  /** The key this value had in the consolidated database before it was renamed */
  legacyKey?: string
  legacyDatabase: LegacyDatabase
  /** Converts a stored value to the current shape, or returns null if it can't be read */
  toCurrent(raw: unknown): unknown
  /** True for a value under the current key that still has a legacy shape */
  needsUpgrade?(raw: unknown): boolean
}

/**
 * Normalizes an array of [ItemId, cursor] entries into a PersistedSyncCursors object.
 * Uses an iterative loop instead of Math.max(...spread) to avoid RangeError: Maximum call stack size exceeded.
 */
export function normalizeCursors(raw: [ItemId, number][]): PersistedSyncCursors {
  let max = 0
  const retries: [ItemId, number][] = []

  for (const entry of raw) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const [itemId, c] = entry
      if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
        if (c > max) {
          max = c
        }
        retries.push([itemId, c])
      }
    }
  }

  return {
    globalCursor: max,
    retries,
  }
}

function hasNumericTimestamp(raw: unknown): boolean {
  return Array.isArray(raw) && raw.some(entry => Array.isArray(entry) && typeof entry[1] === 'number')
}

function upgradeTimestamps(raw: unknown): [ItemId, ItemSyncTimestamps][] | null {
  if (!Array.isArray(raw)) return null
  return (raw as [ItemId, number | ItemSyncTimestamps][]).map(([itemId, value]) => (
    typeof value === 'number'
      ? [itemId, { localModifiedAt: value, lastSnapshotAt: value, baseVersion: 0 }]
      : [itemId, value]
  ))
}

const LEGACY_METADATA_VALUES: LegacyMetadataValue[] = [
  {
    key: SYNC_METADATA_KEYS.CURSORS,
    legacyKey: 'cursorByItemId',
    legacyDatabase: { name: 'flock-sync-cursors', storePrefix: 'cursors', key: 'cursorByItemId' },
    toCurrent: raw => {
      if (Array.isArray(raw)) return normalizeCursors(raw as [ItemId, number][])
      if (raw && typeof raw === 'object' && 'globalCursor' in raw) return raw
      return null
    },
    needsUpgrade: raw => Array.isArray(raw),
  },
  {
    key: SYNC_METADATA_KEYS.INDEX_DOC,
    legacyDatabase: { name: 'flock-item-metadata', storePrefix: 'index', key: 'indexDoc' },
    toCurrent: raw => raw,
  },
  {
    key: SYNC_METADATA_KEYS.LAST_MODIFIED,
    legacyKey: 'lastModifiedByItemId',
    legacyDatabase: { name: 'flock-sync-last-modified', storePrefix: 'last-modified', key: 'lastModifiedByItemId' },
    toCurrent: upgradeTimestamps,
    needsUpgrade: hasNumericTimestamp,
  },
  {
    key: SYNC_METADATA_KEYS.SYNCED_HEADS,
    legacyKey: 'syncedHeadsByDocId',
    legacyDatabase: { name: 'flock-sync-synced-heads', storePrefix: 'synced-heads', key: 'syncedHeadsByDocId' },
    toCurrent: raw => (Array.isArray(raw) ? raw : null),
  },
]

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined
}

function openLegacyDatabase(database: LegacyDatabase, accountId: string): LocalForage {
  return localforage.createInstance({ name: database.name, storeName: `${database.storePrefix}-${accountId}` })
}

/**
 * Reads a value from its per-store database, or returns null. Failures are logged rather than
 * thrown, so a broken legacy database can't stop the worker from starting.
 */
async function readLegacyDatabase(
  value: LegacyMetadataValue,
  accountId: string,
): Promise<{ current: unknown, store: LocalForage } | null> {
  try {
    if (!(await databaseExists(value.legacyDatabase.name))) return null
    const store = openLegacyDatabase(value.legacyDatabase, accountId)
    const raw = await store.getItem<unknown>(value.legacyDatabase.key)
    const current = isPresent(raw) ? value.toCurrent(raw) : null
    return isPresent(current) ? { current, store } : null
  } catch (error) {
    console.warn(`[localData] Failed to read legacy database ${value.legacyDatabase.name}`, error)
    return null
  }
}

async function migrateMetadataValue(value: LegacyMetadataValue, accountId: string): Promise<void> {
  const metadata = getSyncMetadataStorage(accountId)
  const existing = await metadata.getItem<unknown>(value.key)
  if (isPresent(existing)) {
    if (value.needsUpgrade?.(existing)) {
      const upgraded = value.toCurrent(existing)
      if (isPresent(upgraded)) {
        await runStorageOperation(() => metadata.setItem(value.key, upgraded))
      }
    }
    if (value.legacyKey) {
      await runStorageOperation(() => metadata.removeItem(value.legacyKey!))
    }
    return
  }

  if (value.legacyKey) {
    const raw = await metadata.getItem<unknown>(value.legacyKey)
    const current = isPresent(raw) ? value.toCurrent(raw) : null
    if (isPresent(current)) {
      await runStorageOperation(() => metadata.setItem(value.key, current))
      await runStorageOperation(() => metadata.removeItem(value.legacyKey!))
      return
    }
  }

  const legacy = await readLegacyDatabase(value, accountId)
  if (legacy) {
    await runStorageOperation(() => metadata.setItem(value.key, legacy.current))
    await runStorageOperation(() => legacy.store.removeItem(value.legacyDatabase.key)).catch(error => {
      console.warn(`[localData] Failed to remove legacy value from ${value.legacyDatabase.name}`, error)
    })
  }
}

function getLegacyManualRecoveryMetaStorage(accountId: string): LocalForage {
  return createAccountStore(LEGACY_MANUAL_RECOVERY_META_STORE, accountId, {
    name: getAccountDatabaseName(MANUAL_RECOVERY_STORE, accountId),
  })
}

interface StoredManualRecoveryEntry {
  id: string
  itemId: ItemId
  reason: string
  createdAt: number
  kind?: unknown
}

/** Keys manual recovery entries by item ID, merging duplicates for the same item */
async function migrateManualRecoveryEntries(accountId: string): Promise<void> {
  const metadata = getSyncMetadataStorage(accountId)
  if (await metadata.getItem<boolean>(MANUAL_RECOVERY_MIGRATED_KEY)) {
    return
  }

  try {
    const legacyMetaStorage = getLegacyManualRecoveryMetaStorage(accountId)
    const legacyMigrated = await legacyMetaStorage.getItem<boolean>(LEGACY_MANUAL_RECOVERY_MIGRATED_KEY)
    if (legacyMigrated) {
      await runStorageOperation(() => metadata.setItem(MANUAL_RECOVERY_MIGRATED_KEY, true))
      await runStorageOperation(() => legacyMetaStorage.clear()).catch(() => {})
      return
    }
  } catch {
    // Ignore legacy metadata store lookup errors
  }

  const storage = createAccountStore(MANUAL_RECOVERY_STORE, accountId)
  const keys = await storage.keys()
  const entriesByItemId = new Map<ItemId, StoredManualRecoveryEntry[]>()
  const keysToRemove = new Set<string>()

  for (const key of keys) {
    const value = await storage.getItem<StoredManualRecoveryEntry>(key)
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
      const newItem: StoredManualRecoveryEntry = {
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

      const mergedEntry: StoredManualRecoveryEntry = {
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

  await runStorageOperation(() => metadata.setItem(MANUAL_RECOVERY_MIGRATED_KEY, true))

  try {
    await runStorageOperation(() => getLegacyManualRecoveryMetaStorage(accountId).clear())
  } catch {
    // Ignore cleanup error
  }
}

/** The sync worker's `migrateLocalData` hook. Errors from the current stores propagate. */
export async function migrateLegacyLocalData(accountId: string): Promise<void> {
  for (const value of LEGACY_METADATA_VALUES) {
    await migrateMetadataValue(value, accountId)
  }
  await migrateManualRecoveryEntries(accountId)
}

/** Removes the account's data in legacy local stores. Run after the sync worker has shut down. */
export async function clearLegacyLocalData(accountId: string): Promise<void> {
  if (!accountId) return

  await Promise.allSettled([
    ...LEGACY_METADATA_VALUES.map(async ({ legacyDatabase }) => {
      try {
        if (!(await databaseExists(legacyDatabase.name))) return
        const store = openLegacyDatabase(legacyDatabase, accountId)
        await runStorageOperation(() => store.clear())
      } catch (error) {
        console.warn(`[localData] Error clearing legacy store ${legacyDatabase.name}:`, error)
      }
    }),
    runStorageOperation(() => getLegacyManualRecoveryMetaStorage(accountId).clear()).catch(error => {
      console.warn('[localData] Error clearing legacy manual recovery metadata:', error)
    }),
  ])
}
