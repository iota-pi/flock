import type { ItemId } from '@vault/shared'
import { createPendingMark } from './ChangeOutbox'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { clearServerHeads } from './stores/itemSyncRecords'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './stores/syncMetadataStorage'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import { clearWriteAheadLog } from '../shared/writeAheadLogStorage'
import { createLogger } from '../utils/logger'
import { runStorageOperation } from '../utils/storageManager'

const log = createLogger('syncReset')

/**
 * Moves a device that synced before the log onto it, once per account, under the local data lock
 * and before any component reads its state. Old server heads can name changes only the old table
 * held, which no device can read now, so they go, with the old cursors, and every item is marked
 * pending. From there the engine does what it does for any device with no server heads: catch-up's
 * manifest sync merges the server's snapshots first (the cursor is gone), the push sends each item's
 * whole history (a duplicate change is a no-op for every receiver), and S1 holds back each snapshot
 * until its push has landed. Nothing local is reset (rule 10).
 *
 * The flag comes last, so an interrupted run repeats, and it never runs again once set, because a
 * later tab would otherwise clear heads the leader has set. It keeps its first start name, which a
 * device that ran first start's local part has already set: that device's items are pending without
 * server heads, which is all the reset does.
 */
export async function resetSyncState(accountId: string, listItemIds: () => Promise<ItemId[]>): Promise<void> {
  const storage = getSyncMetadataStorage(accountId)
  if (await storage.getItem<boolean>(SYNC_METADATA_KEYS.FIRST_START_RESET)) return

  const db = new SyncLogDatabase(accountId)
  try {
    const itemIds = await listItemIds()
    await db.put(SYNC_LOG_STORES.outbox, ...itemIds.map(createPendingMark))
    await clearServerHeads(db)
  } finally {
    await db.close()
  }
  await runStorageOperation(async () => {
    await storage.removeItem(SYNC_METADATA_KEYS.CURSORS)
    await storage.setItem(SYNC_METADATA_KEYS.FIRST_START_RESET, true)
  })
}

/**
 * Whether the reset has run on this device and the write-ahead log older builds kept is gone, which
 * it clears here if it hasn't yet. Nothing reads the WAL now, so a failure only keeps the device
 * level down until a later check clears it.
 */
export async function hasFinishedSyncReset(accountId: string): Promise<boolean> {
  const storage = getSyncMetadataStorage(accountId)
  if (!await storage.getItem<boolean>(SYNC_METADATA_KEYS.FIRST_START_RESET)) return false
  if (await storage.getItem<boolean>(SYNC_METADATA_KEYS.WAL_CLEARED)) return true
  try {
    await clearWriteAheadLog(accountId)
    await runStorageOperation(() => storage.setItem(SYNC_METADATA_KEYS.WAL_CLEARED, true))
    return true
  } catch (error) {
    log.warn('Failed to clear the write-ahead log; it will be tried at the next check', error)
    return false
  }
}
