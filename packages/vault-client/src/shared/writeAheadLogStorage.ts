import { deleteDatabase } from '../utils/deleteDatabase'
import { clearAccountStore, getAccountDatabaseName } from './createAccountStore'

/**
 * Removes the account's write-ahead log entries without an active log: deletes the plaintext
 * database, without creating it when it doesn't exist, and clears the sealed store. Clearing the
 * plaintext store instead would create an empty plaintext database, which the app's legacy data
 * detection would then find.
 */
export async function clearWriteAheadLog(accountId: string): Promise<void> {
  if (!accountId) return
  await Promise.all([
    deleteDatabase(getAccountDatabaseName('wal-entries', accountId)),
    clearAccountStore('wal-entries-sealed', accountId),
  ])
}
