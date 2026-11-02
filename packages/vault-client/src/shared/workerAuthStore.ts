import { getVaultStorageNames } from './storageNames'
import { deleteDatabase } from '../utils/deleteDatabase'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('workerAuthStore')

/**
 * Deletes the database where earlier builds stored the session token. Deleting doesn't create it, as
 * opening it would. A tab of an earlier build may hold it open, so this doesn't wait for the deletion,
 * which completes once that tab closes it.
 */
export function deleteStoredSessionToken(): void {
  fireAndForget(deleteDatabase(getVaultStorageNames().authDatabase), 'workerAuthStore', err => {
    log.warn('Could not delete the stored session token', err)
  })
}
