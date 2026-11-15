import { clearSyncMetadataStorage } from '../shared/syncMetadataStorage'
import { clearManualRecoveryEntries } from '../shared/manualRecoveryStore'
import { getAutomergeDBName, getSealedAutomergeDBName } from '../shared/localDatabaseNames'
import { clearSyncLogStorage } from '../shared/syncLogStorage'
import { clearWriteAheadLog } from '../shared/writeAheadLogStorage'
import { deleteDatabase } from '../utils/deleteDatabase'
import { createLogger } from '../utils/logger'

const log = createLogger('localDataCleanup')

/** Some of an account's local data could not be deleted, such as a database another tab held open */
export class LocalDataCleanupError extends Error {
  constructor(readonly failures: string[]) {
    super(`Failed to clear local data: ${failures.join(', ')}`)
    this.name = 'LocalDataCleanupError'
  }
}

/**
 * Single source of truth for clearing all local account data during logout or account reset.
 * Cleans up Automerge IndexedDB, sync metadata, the sync log's local stores, any WAL an older build
 * left, and manual recovery entries.
 * Must be executed after the sync worker has closed its connections to prevent concurrent database
 * operations and versionchange deadlocks.
 * Tries every step even when one fails, then throws `LocalDataCleanupError` naming those that failed.
 */
export async function clearAccountLocalData(accountId: string): Promise<void> {
  if (!accountId) return
  const steps: [string, () => Promise<void>][] = [
    ['Automerge IndexedDB', () => deleteDatabase(getAutomergeDBName(accountId))],
    ['sealed Automerge IndexedDB', () => deleteDatabase(getSealedAutomergeDBName(accountId))],
    ['SyncMetadataStorage', () => clearSyncMetadataStorage(accountId)],
    ['sync log stores', () => clearSyncLogStorage(accountId)],
    ['write-ahead log', () => clearWriteAheadLog(accountId)],
    ['ManualRecovery', () => clearManualRecoveryEntries(accountId)],
  ]
  const results = await Promise.allSettled(steps.map(([, step]) => step()))
  const failures: string[] = []
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const [name] = steps[i]
      log.error(`Failed to clear ${name}`, result.reason)
      failures.push(name)
    }
  })
  if (failures.length > 0) {
    throw new LocalDataCleanupError(failures)
  }
}
