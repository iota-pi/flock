import { getVaultStorageNames } from './storageNames'
import { createLogger } from '../utils/logger'

const log = createLogger('workerAuthStore')

/**
 * Deletes the database where earlier builds stored the session token. Deleting doesn't create it, as
 * opening it would. A tab of an earlier build may hold it open, so this doesn't wait for the deletion,
 * which completes once that tab closes it.
 */
export function deleteStoredSessionToken(): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve()
  return new Promise(resolve => {
    const request = indexedDB.deleteDatabase(getVaultStorageNames().authDatabase)
    request.onsuccess = () => resolve()
    request.onblocked = () => resolve()
    request.onerror = () => {
      log.warn('Could not delete the stored session token', request.error)
      resolve()
    }
  })
}
