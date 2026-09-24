import localforage from 'localforage'
import { runStorageOperation, type RunStorageOperationOptions } from '../../../utils/storageManager'
import {
  createAccountStore,
  clearAccountStore,
  clearAccountStoreInstancesCacheForTesting,
  getAccountDatabaseName,
} from '../../shared/createAccountStore'
import { BaseLocalForageStore } from './BaseLocalForageStore'

export const SYNC_METADATA_STORE_NAME = 'sync-metadata'

export const SYNC_METADATA_KEYS = {
  CURSORS: 'cursors',
  INDEX_DOC: 'indexDoc',
  LAST_MODIFIED: 'lastModified',
  SYNCED_HEADS: 'syncedHeads',
  MANUAL_RECOVERY_MIGRATED: 'manualRecoveryMigrated',
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
  MANUAL_RECOVERY_MIGRATED: '__migrated_v2',
} as const

export function getSyncMetadataDBName(accountId: string): string {
  return getAccountDatabaseName(SYNC_METADATA_STORE_NAME, accountId)
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
  return createAccountStore(SYNC_METADATA_STORE_NAME, accountId)
}

/**
 * Clears the in-memory cache of LocalForage instances. Useful for testing.
 */
export const clearSyncMetadataInstancesCacheForTesting = clearAccountStoreInstancesCacheForTesting

/**
 * Clears the consolidated sync metadata database for an account.
 */
export async function clearSyncMetadataStorage(accountId: string): Promise<void> {
  await clearAccountStore(SYNC_METADATA_STORE_NAME, accountId)
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

export interface ScopedMetadataStoreOptions<T> {
  metadataKey: string
  legacyKey?: string
  legacyDbName?: string
  legacyStorePrefix?: string
  storeLabel?: string
  normalize?: (raw: unknown) => T | null
  shouldUpgradeInPlace?: (raw: unknown) => boolean
}

/**
 * Generic base class for account-scoped metadata stores backed by the consolidated IndexedDB database.
 * Encapsulates string | LocalForage constructor, scoped clear(), and two-tier legacy migration.
 */
export abstract class ScopedMetadataStore<T> extends BaseLocalForageStore {
  protected readonly accountId: string | null
  protected readonly metadataKey: string
  protected readonly legacyKey?: string
  protected readonly legacyDbName?: string
  protected readonly legacyStorePrefix?: string
  protected readonly storeLabel: string
  protected readonly normalizeValue?: (raw: unknown) => T | null
  protected readonly shouldUpgradeInPlace?: (raw: unknown) => boolean

  constructor(accountIdOrStore: string | LocalForage, options: ScopedMetadataStoreOptions<T>) {
    if (typeof accountIdOrStore === 'string') {
      super(getSyncMetadataStorage(accountIdOrStore))
      this.accountId = accountIdOrStore
    } else {
      super(accountIdOrStore)
      this.accountId = null
    }

    this.metadataKey = options.metadataKey
    this.legacyKey = options.legacyKey
    this.legacyDbName = options.legacyDbName
    this.legacyStorePrefix = options.legacyStorePrefix
    this.storeLabel = options.storeLabel ?? 'ScopedMetadataStore'
    this.normalizeValue = options.normalize
    this.shouldUpgradeInPlace = options.shouldUpgradeInPlace
  }

  async getScopedData(): Promise<T | null> {
    const raw = await this.getItem<unknown>(this.metadataKey)
    if (raw !== null && raw !== undefined) {
      if (this.normalizeValue) {
        const normalized = this.normalizeValue(raw)
        if (normalized !== null) {
          if (this.shouldUpgradeInPlace?.(raw)) {
            await this.setScopedData(normalized)
          }
          return normalized
        }
      } else {
        return raw as T
      }
    }

    return this.migrateLegacyData()
  }

  async setScopedData(data: T, options?: RunStorageOperationOptions): Promise<void> {
    await this.setItem(this.metadataKey, data, options)
  }

  override async clear(options?: RunStorageOperationOptions): Promise<void> {
    await this.removeItem(this.metadataKey, options)
    if (this.legacyKey && this.legacyKey !== this.metadataKey) {
      await this.removeItem(this.legacyKey, options).catch(() => {})
    }
  }

  protected async migrateLegacyData(): Promise<T | null> {
    // 1. Check in-store legacy key
    if (this.legacyKey && this.legacyKey !== this.metadataKey) {
      const inStoreLegacy = await this.getItem<unknown>(this.legacyKey)
      if (inStoreLegacy !== null && inStoreLegacy !== undefined) {
        const migrated = this.normalizeValue
          ? this.normalizeValue(inStoreLegacy)
          : (inStoreLegacy as T)
        if (migrated !== null) {
          await this.setScopedData(migrated)
          await this.removeItem(this.legacyKey).catch(() => {})
          return migrated
        }
      }
    }

    // 2. Check legacy database
    if (this.accountId && this.legacyDbName && this.legacyStorePrefix && this.legacyKey) {
      try {
        const hasLegacy = await hasLegacyDatabase(this.legacyDbName)
        if (hasLegacy) {
          const legacyStore = localforage.createInstance({
            name: this.legacyDbName,
            storeName: `${this.legacyStorePrefix}-${this.accountId}`,
          })
          const legacyData = await legacyStore.getItem<unknown>(this.legacyKey)
          if (legacyData !== null && legacyData !== undefined) {
            const migrated = this.normalizeValue
              ? this.normalizeValue(legacyData)
              : (legacyData as T)
            if (migrated !== null) {
              await this.setScopedData(migrated)
              await legacyStore.removeItem(this.legacyKey).catch(() => {})
              return migrated
            }
          }
        }
      } catch (err) {
        console.warn(`[${this.storeLabel}] Failed to migrate legacy data:`, err)
      }
    }

    return null
  }
}

