import { getAutomergeDBName } from '../worker/AutomergeRepoManager'
import { clearSyncMetadataStorage } from '../worker/stores/syncMetadataStorage'
import { SyncWriteAheadLog } from '../worker/SyncWriteAheadLog'
import { clearManualRecoveryEntries } from '../shared/manualRecoveryStore'
import { getSealedAutomergeDBName } from '../shared/localDatabaseNames'
import { getAccountDatabaseName } from '../shared/createAccountStore'
import { SYNC_TIMEOUTS } from '../syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('localDataCleanup')

/**
 * Deletes an IndexedDB database by name, such as an account's plaintext or sealed Automerge database.
 * Relies on the worker having already cleanly closed its storage connection
 * to prevent versionchange blocks and timeouts.
 */
export async function clearAutomergeIndexedDb(dbName: string, timeoutMs: number = SYNC_TIMEOUTS.localDataCleanup): Promise<void> {
  if (typeof indexedDB === 'undefined') {
    return
  }

  return new Promise<void>((resolve, reject) => {
    let settled = false
    let isBlocked = false

    const req = indexedDB.deleteDatabase(dbName)
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      req.onsuccess = null
      req.onerror = null
      req.onblocked = null
    }

    timer = setTimeout(() => {
      if (settled) return
      const errMsg = isBlocked
        ? `deleteDatabase blocked and timed out after ${timeoutMs}ms for ${dbName}`
        : `deleteDatabase timed out after ${timeoutMs}ms for ${dbName}`
      log.error(errMsg)
      cleanup()
      reject(new Error(errMsg))
    }, timeoutMs)

    req.onsuccess = () => {
      if (settled) return
      cleanup()
      resolve()
    }

    req.onerror = () => {
      if (settled) return
      log.error(`Error deleting IndexedDB database ${dbName}:`, req.error)
      const err = req.error || new Error(`Error deleting IndexedDB database ${dbName}`)
      cleanup()
      reject(err)
    }

    req.onblocked = () => {
      if (settled) return
      isBlocked = true
      log.warn(`deleteDatabase blocked for ${dbName}, waiting for open connections to close`)
    }
  })
}

/**
 * Removes the account's write-ahead log entries: deletes the plaintext database, without creating it
 * when it doesn't exist, and clears the sealed store.
 */
export async function clearWriteAheadLog(accountId: string): Promise<void> {
  if (!accountId) return
  await Promise.all([
    clearAutomergeIndexedDb(getAccountDatabaseName('wal-entries', accountId)),
    SyncWriteAheadLog.clearSealed(accountId),
  ])
}

/**
 * Single source of truth for clearing all local account data during logout or account reset.
 * Cleans up Automerge IndexedDB, sync metadata, WAL, and manual recovery entries.
 * Must be executed after the sync worker has closed its connections to prevent concurrent database
 * operations and versionchange deadlocks.
 */
export async function clearAccountLocalData(accountId: string): Promise<void> {
  if (!accountId) return
  try {
    await Promise.allSettled([
      clearAutomergeIndexedDb(getAutomergeDBName(accountId)).catch(err => log.error('Failed to clear Automerge IndexedDB', err)),
      clearAutomergeIndexedDb(getSealedAutomergeDBName(accountId)).catch(err => log.error('Failed to clear sealed Automerge IndexedDB', err)),
      clearSyncMetadataStorage(accountId).catch(err => log.error('Failed to clear SyncMetadataStorage', err)),
      clearWriteAheadLog(accountId).catch(err => log.error('Failed to clear SyncWriteAheadLog', err)),
      clearManualRecoveryEntries(accountId).catch(err => log.error('Failed to clear ManualRecovery', err)),
    ])
  } catch (err) {
    log.error(`Error clearing local data for account ${accountId}:`, err)
  }
}
