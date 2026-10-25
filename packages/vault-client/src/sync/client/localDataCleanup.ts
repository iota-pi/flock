import { getAutomergeDBName } from '../worker/AutomergeRepoManager'
import { clearSyncMetadataStorage } from '../worker/stores/syncMetadataStorage'
import { clearManualRecoveryEntries } from '../shared/manualRecoveryStore'
import { getSealedAutomergeDBName } from '../shared/localDatabaseNames'
import { clearWriteAheadLog } from '../shared/writeAheadLogStorage'
import { deleteDatabase } from '../utils/deleteDatabase'
import { createLogger } from '../utils/logger'

const log = createLogger('localDataCleanup')

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
      deleteDatabase(getAutomergeDBName(accountId)).catch(err => log.error('Failed to clear Automerge IndexedDB', err)),
      deleteDatabase(getSealedAutomergeDBName(accountId)).catch(err => log.error('Failed to clear sealed Automerge IndexedDB', err)),
      clearSyncMetadataStorage(accountId).catch(err => log.error('Failed to clear SyncMetadataStorage', err)),
      clearWriteAheadLog(accountId).catch(err => log.error('Failed to clear SyncWriteAheadLog', err)),
      clearManualRecoveryEntries(accountId).catch(err => log.error('Failed to clear ManualRecovery', err)),
    ])
  } catch (err) {
    log.error(`Error clearing local data for account ${accountId}:`, err)
  }
}
