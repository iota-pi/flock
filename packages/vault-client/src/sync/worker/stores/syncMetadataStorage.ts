import type { RunStorageOperationOptions } from '../../utils/storageManager'
import {
  createAccountStore,
  clearAccountStore,
  getAccountDatabaseName,
} from '../../shared/createAccountStore'
import { BaseLocalForageStore } from './BaseLocalForageStore'

export const SYNC_METADATA_STORE_NAME = 'sync-metadata'

export const SYNC_METADATA_KEYS = {
  CURSORS: 'cursors',
  INDEX_DOC: 'indexDoc',
  /** The index sealed with the device storage key (see IndexStore) */
  INDEX_DOC_SEALED: 'indexDocSealed',
  LAST_MODIFIED: 'lastModified',
  SYNCED_HEADS: 'syncedHeads',
  /** Set once this device has rewritten every snapshot bound to its document (see SnapshotFormatUpgrade) */
  SNAPSHOTS_DOC_BOUND: 'snapshotsDocBound',
  /** The app's data version this device's local data has been migrated to (see DataVersionTracker) */
  DEVICE_DATA_VERSION: 'deviceDataVersion',
} as const

export function getSyncMetadataDBName(accountId: string): string {
  return getAccountDatabaseName(SYNC_METADATA_STORE_NAME, accountId)
}

/**
 * Returns a cached LocalForage instance for the account's consolidated sync metadata database.
 * This ensures only a single IndexedDB connection pool is maintained across all 4 metadata stores.
 */
export function getSyncMetadataStorage(accountId: string): LocalForage {
  return createAccountStore(SYNC_METADATA_STORE_NAME, accountId)
}

/**
 * Clears the consolidated sync metadata database for an account.
 */
export async function clearSyncMetadataStorage(accountId: string): Promise<void> {
  await clearAccountStore(SYNC_METADATA_STORE_NAME, accountId)
}

export interface ScopedMetadataStoreOptions<T> {
  metadataKey: string
  /** Validates the stored value. Returning null treats it as missing. */
  normalize?: (raw: unknown) => T | null
}

/**
 * Generic base class for account-scoped metadata stores backed by the consolidated IndexedDB database.
 * Each store owns one key. Values in older layouts are migrated by the app's `migrateLocalData` hook
 * before any store is read.
 */
export abstract class ScopedMetadataStore<T> extends BaseLocalForageStore {
  protected readonly metadataKey: string
  protected readonly normalizeValue?: (raw: unknown) => T | null

  constructor(accountIdOrStore: string | LocalForage, options: ScopedMetadataStoreOptions<T>) {
    super(typeof accountIdOrStore === 'string' ? getSyncMetadataStorage(accountIdOrStore) : accountIdOrStore)
    this.metadataKey = options.metadataKey
    this.normalizeValue = options.normalize
  }

  async getScopedData(): Promise<T | null> {
    const raw = await this.getItem<unknown>(this.metadataKey)
    if (raw === null || raw === undefined) return null
    return this.normalizeValue ? this.normalizeValue(raw) : raw as T
  }

  async setScopedData(data: T, options?: RunStorageOperationOptions): Promise<void> {
    await this.setItem(this.metadataKey, data, options)
  }

  override async clear(options?: RunStorageOperationOptions): Promise<void> {
    await this.removeItem(this.metadataKey, options)
  }
}
