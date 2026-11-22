import type { PendingMark } from '../ChangeOutbox'
import { SYNC_LOG_STORES } from '../../shared/syncLogStorage'
import { SyncLogDatabase } from './SyncLogDatabase'

/** A pending mark as stored, which builds before marks had an age wrote without `createdAt` */
type StoredPendingMark = Omit<PendingMark, 'createdAt'> & Partial<Pick<PendingMark, 'createdAt'>>

/**
 * Dates pending marks from builds before marks had an age from now, which is the first anyone has
 * seen them, for the app's `migrateLocalData` hook. Builds since write dated marks, and older ones
 * can't open the sync log database since version 3, so this can go when device level 4 is retired.
 */
export async function datePendingMarks(accountId: string, now = Date.now()): Promise<void> {
  const db = new SyncLogDatabase(accountId)
  try {
    const marks = await db.getAll<StoredPendingMark>(SYNC_LOG_STORES.outbox)
    const undated = marks.filter(mark => mark.createdAt === undefined).map(mark => mark.itemId)
    await db.update<StoredPendingMark>(
      SYNC_LOG_STORES.outbox,
      undated,
      current => (current && current.createdAt === undefined ? { ...current, createdAt: now } : undefined),
    )
  } finally {
    await db.close()
  }
}
