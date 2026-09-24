import localforage from 'localforage'
import { runStorageOperation } from '../../utils/storageManager'

export interface CreateAccountStoreOptions {
  dbName?: string
  name?: string
  description?: string
  driver?: string | string[]
}

const DEFAULT_DB_PREFIX_BY_STORE: Record<string, string> = {
  'sync-batch-messages': 'FlockVault_SyncBatchDB_',
  'manual-recovery-items': 'FlockVault_ManualRecoveryDB_',
  'manual-recovery-metadata': 'FlockVault_ManualRecoveryDB_',
  'wal-entries': 'FlockVault_SyncWAL_',
  'sync-metadata': 'flock-sync-metadata-',
}

const DEFAULT_DESCRIPTION_BY_STORE: Record<string, string> = {
  'sync-metadata': 'Consolidated sync metadata for Flock account',
}

export function getAccountDatabaseName(storeName: string, accountId: string): string {
  const prefix = DEFAULT_DB_PREFIX_BY_STORE[storeName]
  if (prefix) {
    return `${prefix}${accountId}`
  }
  return `FlockVault_${storeName}_${accountId}`
}

export function resolveAccountStoreConfig(
  storeName: string,
  accountId: string,
  options?: CreateAccountStoreOptions
): { name: string; storeName: string; description?: string; driver?: string | string[] } {
  const name = options?.name ?? options?.dbName ?? getAccountDatabaseName(storeName, accountId)
  const config: { name: string; storeName: string; description?: string; driver?: string | string[] } = {
    name,
    storeName,
  }
  const description = options?.description ?? DEFAULT_DESCRIPTION_BY_STORE[storeName]
  if (description) {
    config.description = description
  }
  if (options?.driver) {
    config.driver = options.driver
  }
  return config
}

const storageInstances = new Map<string, LocalForage>()

/**
 * Creates or retrieves a cached LocalForage instance for an account-scoped store.
 * Instances are cached by database name and store name to avoid connection pool proliferation.
 */
export function createAccountStore(
  storeName: string,
  accountId: string,
  options?: CreateAccountStoreOptions
): LocalForage {
  const config = resolveAccountStoreConfig(storeName, accountId, options)
  const cacheKey = `${config.name}::${config.storeName}`
  let instance = storageInstances.get(cacheKey)
  if (!instance) {
    instance = localforage.createInstance(config)
    storageInstances.set(cacheKey, instance)
  }
  return instance
}

export const getAccountStore = createAccountStore

/**
 * Clears the in-memory cache of LocalForage instances.
 */
export function clearAccountStoreInstancesCacheForTesting(): void {
  storageInstances.clear()
}

export const clearInstancesCacheForTesting = clearAccountStoreInstancesCacheForTesting

/**
 * Clears the underlying storage data for a specific account store.
 */
export async function clearAccountStore(
  storeName: string,
  accountId: string,
  options?: CreateAccountStoreOptions
): Promise<void> {
  if (!accountId) return
  const store = createAccountStore(storeName, accountId, options)
  await runStorageOperation(() => store.clear())
}
