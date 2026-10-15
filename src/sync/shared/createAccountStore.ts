import localforage from 'localforage'
import { runStorageOperation } from '../utils/storageManager'
import { getVaultStorageNames, type VaultStorageNames } from './storageNames'

export interface CreateAccountStoreOptions {
  dbName?: string
  name?: string
  description?: string
  driver?: string | string[]
}

const DB_PREFIX_KEY_BY_STORE: Record<string, keyof VaultStorageNames['accountPrefixes']> = {
  'manual-recovery-items': 'manualRecoveryDatabase',
  'wal-entries': 'walDatabase',
  'sync-metadata': 'syncMetadataDatabase',
}

const DEFAULT_DESCRIPTION_BY_STORE: Record<string, string> = {
  'sync-metadata': 'Consolidated vault sync metadata for an account',
}

export function getAccountDatabaseName(storeName: string, accountId: string): string {
  const prefixes = getVaultStorageNames().accountPrefixes
  const prefixKey = DB_PREFIX_KEY_BY_STORE[storeName]
  if (prefixKey) {
    return `${prefixes[prefixKey]}${accountId}`
  }
  return `${prefixes.accountStoreDatabase}${storeName}_${accountId}`
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

/**
 * Clears the in-memory cache of LocalForage instances.
 */
export function clearAccountStoreInstancesCacheForTesting(): void {
  storageInstances.clear()
}

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
