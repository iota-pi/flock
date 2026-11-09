import type { ItemId } from '@vault/shared'
import { runStorageOperation, type RunStorageOperationOptions } from '../../utils/storageManager'
import { createAccountStore } from '../../shared/createAccountStore'
import { SYNC_METADATA_STORE_NAME } from '../../shared/syncMetadataStorage'

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
  /** When this device last completed a sync with the server (see SyncProgressTracker) */
  LAST_SYNCED_AT: 'lastSyncedAt',
  /** The highest log seq this device has processed (see SyncLogPuller) */
  LOG_CURSOR: 'logCursor',
  /** The server's clock at this device's last pull that reached the end of the log */
  LOG_LAST_PULL_AT: 'logLastPullAt',
  /** Set once this device has reset its sync state for the sync log (see FirstStart) */
  FIRST_START_RESET: 'firstStartReset',
  /** Set once this device has reconciled with the server for the sync log (see FirstStart) */
  FIRST_START_SYNCED: 'firstStartSynced',
  /** Set once the write-ahead log that older builds kept has been cleared (see FirstStart) */
  WAL_CLEARED: 'walCleared',
} as const

/** The cursors older builds kept under `SYNC_METADATA_KEYS.CURSORS`, which first start clears */
export interface PersistedSyncCursors {
  globalCursor: number
  retries?: [ItemId, number][]
}

/**
 * Returns a cached LocalForage instance for the account's consolidated sync metadata database.
 * This ensures only a single IndexedDB connection pool is maintained across all 4 metadata stores.
 */
export function getSyncMetadataStorage(accountId: string): LocalForage {
  return createAccountStore(SYNC_METADATA_STORE_NAME, accountId)
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
export abstract class ScopedMetadataStore<T> {
  protected readonly store: LocalForage
  protected readonly metadataKey: string
  protected readonly normalizeValue?: (raw: unknown) => T | null

  constructor(accountId: string, options: ScopedMetadataStoreOptions<T>) {
    this.store = getSyncMetadataStorage(accountId)
    this.metadataKey = options.metadataKey
    this.normalizeValue = options.normalize
  }

  protected async getItem<V>(key: string): Promise<V | null> {
    return this.store.getItem<V>(key)
  }

  protected async setItem<V>(key: string, value: V, options?: RunStorageOperationOptions): Promise<V> {
    return runStorageOperation(() => this.store.setItem(key, value), options)
  }

  protected async getScopedData(): Promise<T | null> {
    const raw = await this.getItem<unknown>(this.metadataKey)
    if (raw === null || raw === undefined) return null
    return this.normalizeValue ? this.normalizeValue(raw) : raw as T
  }

  protected async setScopedData(data: T, options?: RunStorageOperationOptions): Promise<void> {
    await this.setItem(this.metadataKey, data, options)
  }

  /** Removes this store's key, leaving the rest of the consolidated database intact */
  async clear(options?: RunStorageOperationOptions): Promise<void> {
    await runStorageOperation(() => this.store.removeItem(this.metadataKey), options)
  }

  /**
   * Probes storage availability by writing and removing a temporary key.
   * Intercepts and surfaces QuotaExceededError if storage quota is full.
   */
  async testStorageAvailable(): Promise<boolean> {
    const probeKey = '__quota_probe__'
    await runStorageOperation(
      async () => {
        await this.store.setItem(probeKey, Date.now())
        await this.store.removeItem(probeKey)
      },
      { retryOnQuotaError: false }
    )
    return true
  }
}
