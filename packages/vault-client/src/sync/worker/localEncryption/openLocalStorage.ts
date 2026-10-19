import { getAutomergeDBName } from '../AutomergeRepoManager'
import { VaultIndexedDBStorageAdapter } from '../VaultIndexedDBStorageAdapter'

/** The account's local Automerge storage, chosen before the Repo is created */
export interface LocalStorage {
  storage: VaultIndexedDBStorageAdapter
}

/**
 * Opens the account's local storage. Runs under the account's local data lock, before the Repo or
 * any store reads local data, so the storage it picks is the only one this session uses.
 */
export async function openLocalStorage(accountId: string): Promise<LocalStorage> {
  return { storage: new VaultIndexedDBStorageAdapter(getAutomergeDBName(accountId)) }
}
