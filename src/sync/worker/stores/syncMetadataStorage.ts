import localforage from 'localforage'
import { runStorageOperation } from '../../../utils/storageManager'

export const SYNC_METADATA_STORE_NAME = 'sync-metadata'

export const SYNC_METADATA_KEYS = {
  CURSORS: 'cursors',
  INDEX_DOC: 'indexDoc',
  LAST_MODIFIED: 'lastModified',
  SYNCED_HEADS: 'syncedHeads',
} as const

export const LEGACY_DB_NAMES = {
  CURSORS: 'flock-sync-cursors',
  INDEX_DOC: 'flock-item-metadata',
  LAST_MODIFIED: 'flock-sync-last-modified',
  SYNCED_HEADS: 'flock-sync-synced-heads',
} as const

export const LEGACY_KEYS = {
  CURSORS: 'cursorByItemId',
  INDEX_DOC: 'indexDoc',
  LAST_MODIFIED: 'lastModifiedByItemId',
  SYNCED_HEADS: 'syncedHeadsByDocId',
} as const

const metadataStoreInstances = new Map<string, LocalForage>()

export function getSyncMetadataDBName(accountId: string): string {
  return `flock-sync-metadata-${accountId}`
}

/**
 * Checks if a legacy database exists in IndexedDB before attempting to open it,
 * preventing accidental creation of legacy databases.
 */
export async function hasLegacyDatabase(dbName: string): Promise<boolean> {
  if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
    try {
      const dbs = await indexedDB.databases()
      return Array.isArray(dbs) && dbs.some(db => db && db.name === dbName)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Returns a cached LocalForage instance for the account's consolidated sync metadata database.
 * This ensures only a single IndexedDB connection pool is maintained across all 4 metadata stores.
 */
export function getSyncMetadataStorage(accountId: string): LocalForage {
  let instance = metadataStoreInstances.get(accountId)
  if (!instance) {
    instance = localforage.createInstance({
      name: getSyncMetadataDBName(accountId),
      storeName: SYNC_METADATA_STORE_NAME,
      description: 'Consolidated sync metadata for Flock account',
    })
    metadataStoreInstances.set(accountId, instance)
  }
  return instance
}

/**
 * Clears the in-memory cache of LocalForage instances. Useful for testing.
 */
export function clearSyncMetadataInstancesCacheForTesting(): void {
  metadataStoreInstances.clear()
}

/**
 * Clears the consolidated sync metadata database for an account.
 */
export async function clearSyncMetadataStorage(accountId: string): Promise<void> {
  if (!accountId) return
  const instance = getSyncMetadataStorage(accountId)
  await runStorageOperation(() => instance.clear())
}

/**
 * Cleans up legacy separate singleton IndexedDB databases for an account.
 */
export async function clearLegacySyncDatabases(accountId: string): Promise<void> {
  if (!accountId) return

  const legacyStoreConfigs = [
    { name: LEGACY_DB_NAMES.CURSORS, storeName: `cursors-${accountId}` },
    { name: LEGACY_DB_NAMES.INDEX_DOC, storeName: `index-${accountId}` },
    { name: LEGACY_DB_NAMES.LAST_MODIFIED, storeName: `last-modified-${accountId}` },
    { name: LEGACY_DB_NAMES.SYNCED_HEADS, storeName: `synced-heads-${accountId}` },
  ]

  await Promise.allSettled(
    legacyStoreConfigs.map(async config => {
      try {
        const exists = await hasLegacyDatabase(config.name)
        if (!exists && typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
          return
        }
        const store = localforage.createInstance(config)
        await runStorageOperation(() => store.clear())
      } catch (err) {
        console.warn(`[syncMetadataStorage] Error clearing legacy store ${config.name}:`, err)
      }
    })
  )
}
