import { deleteDatabase } from '../utils/deleteDatabase'
import { getSealedWalDBName, getWalDBName } from './localDatabaseNames'

/**
 * Removes the account's write-ahead logs by deleting their databases, which doesn't create one that
 * doesn't exist. Clearing a store instead would create an empty database, and the app's legacy data
 * detection would find an empty plaintext one.
 */
export async function clearWriteAheadLog(accountId: string): Promise<void> {
  if (!accountId) return
  await Promise.all([
    deleteDatabase(getWalDBName(accountId)),
    deleteDatabase(getSealedWalDBName(accountId)),
  ])
}
