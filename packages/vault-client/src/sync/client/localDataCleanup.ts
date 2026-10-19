import { getAutomergeDBName } from '../worker/AutomergeRepoManager'
import { clearSyncMetadataStorage } from '../worker/stores/syncMetadataStorage'
import { SyncWriteAheadLog } from '../worker/SyncWriteAheadLog'
import { clearManualRecoveryEntries } from '../shared/manualRecoveryStore'
import { getSealedAutomergeDBName } from '../shared/localDatabaseNames'
import { SYNC_TIMEOUTS } from '../syncConfig'

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
        ? `[SyncBridge] deleteDatabase blocked and timed out after ${timeoutMs}ms for ${dbName}`
        : `[SyncBridge] deleteDatabase timed out after ${timeoutMs}ms for ${dbName}`
      console.error(errMsg)
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
      console.error(`[SyncBridge] Error deleting IndexedDB database ${dbName}:`, req.error)
      const err = req.error || new Error(`[SyncBridge] Error deleting IndexedDB database ${dbName}`)
      cleanup()
      reject(err)
    }

    req.onblocked = () => {
      if (settled) return
      isBlocked = true
      console.warn(`[SyncBridge] deleteDatabase blocked for ${dbName}, waiting for open connections to close`)
    }
  })
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
      clearAutomergeIndexedDb(getAutomergeDBName(accountId)).catch(err => console.error('[SyncBridge] Failed to clear Automerge IndexedDB', err)),
      clearAutomergeIndexedDb(getSealedAutomergeDBName(accountId)).catch(err => console.error('[SyncBridge] Failed to clear sealed Automerge IndexedDB', err)),
      clearSyncMetadataStorage(accountId).catch(err => console.error('[SyncBridge] Failed to clear SyncMetadataStorage', err)),
      SyncWriteAheadLog.clear(accountId).catch(err => console.error('[SyncBridge] Failed to clear SyncWriteAheadLog', err)),
      clearManualRecoveryEntries(accountId).catch(err => console.error('[SyncBridge] Failed to clear ManualRecovery', err)),
    ])
  } catch (err) {
    console.error(`[SyncBridge] Error clearing local data for account ${accountId}:`, err)
  }
}
