import type { ItemId } from '@vault/shared'
import { SYNC_LOG_STORES } from '../../shared/syncLogStorage'
import { SyncLogDatabase } from './SyncLogDatabase'

/**
 * What this device knows of an item's copy on the server, one record per item in the sync log
 * database. Each writer changes only its own fields, in one transaction, so tabs never race on a
 * shared value and a save never rewrites other items.
 */
export interface ItemSyncRecord {
  itemId: ItemId
  /** Heads whose every ancestor is on the server, in the log or in the item's snapshot (see ItemSyncState) */
  serverHeads?: string[]
  /** The server version of the latest snapshot this device uploaded or merged (sync rule 8) */
  baseVersion?: number
  /** Set while the item owes the server a snapshot (see SnapshotSchedule) */
  dirty?: true
  /** Set while only a snapshot can deliver the item's changes, which the log refused or can't hold */
  snapshotOnly?: true
  /**
   * When this device first pulled changes to the item that no snapshot has confirmed yet (rule S2 of
   * snapshot coverage)
   */
  pulledAt?: number
}

type ItemSyncRecordsDatabase = Pick<SyncLogDatabase, 'getAll' | 'update'>

/** Reads every item's record */
export async function readItemSyncRecords(db: Pick<SyncLogDatabase, 'getAll'>): Promise<ItemSyncRecord[]> {
  return db.getAll<ItemSyncRecord>(SYNC_LOG_STORES.items)
}

/**
 * Rewrites the records of `itemIds` with what `change` makes of each, in one transaction. `change`
 * gets an empty record for an item that has none.
 */
export async function updateItemSyncRecords(
  db: ItemSyncRecordsDatabase,
  itemIds: ItemId[],
  change: (record: ItemSyncRecord) => ItemSyncRecord,
): Promise<void> {
  await db.update<ItemSyncRecord>(
    SYNC_LOG_STORES.items,
    itemIds,
    (current, key) => change(current ?? { itemId: key as ItemId }),
  )
}

/** Forgets every item's server heads, keeping the rest of its record (see `resetSyncState`) */
export async function clearServerHeads(db: ItemSyncRecordsDatabase): Promise<void> {
  const withHeads = (await readItemSyncRecords(db)).filter(record => record.serverHeads !== undefined)
  await updateItemSyncRecords(db, withHeads.map(record => record.itemId), ({ serverHeads: _, ...rest }) => rest)
}

/**
 * Adds records from an older layout, for the app's `migrateLocalData` hook. A field an item's record
 * already has wins, since nothing older than the record can be newer: base versions keep the higher,
 * an item stays dirty or snapshot-only if either says so, and an unconfirmed pull keeps the earlier time.
 */
export async function importItemSyncRecords(accountId: string, records: ItemSyncRecord[]): Promise<void> {
  if (records.length === 0) return
  const byId = new Map(records.map(record => [record.itemId, record]))
  const db = new SyncLogDatabase(accountId)
  try {
    await updateItemSyncRecords(db, Array.from(byId.keys()), current => {
      const imported = byId.get(current.itemId)!
      const baseVersion = Math.max(current.baseVersion ?? 0, imported.baseVersion ?? 0)
      const serverHeads = current.serverHeads ?? imported.serverHeads
      const pulledAt = Math.min(current.pulledAt ?? Infinity, imported.pulledAt ?? Infinity)
      return {
        ...current,
        ...(serverHeads ? { serverHeads } : {}),
        ...(baseVersion > 0 ? { baseVersion } : {}),
        ...(current.dirty || imported.dirty ? { dirty: true } : {}),
        ...(current.snapshotOnly || imported.snapshotOnly ? { snapshotOnly: true } : {}),
        ...(Number.isFinite(pulledAt) ? { pulledAt } : {}),
      }
    })
  } finally {
    await db.close()
  }
}
