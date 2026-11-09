import { clearAccountStore } from './createAccountStore'

/** The store of the account's sync metadata database (see worker/stores/syncMetadataStorage) */
export const SYNC_METADATA_STORE_NAME = 'sync-metadata'

/**
 * Clears the consolidated sync metadata database for an account.
 */
export async function clearSyncMetadataStorage(accountId: string): Promise<void> {
  await clearAccountStore(SYNC_METADATA_STORE_NAME, accountId)
}
