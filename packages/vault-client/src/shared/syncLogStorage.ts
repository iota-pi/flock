import { deleteDatabase } from '../utils/deleteDatabase'
import { getVaultStorageNames } from './storageNames'

/**
 * The object stores of the account's sync log database. None holds user content in the clear: they
 * hold item IDs, heads and counters, and parked entries hold the server's ciphertext.
 */
export const SYNC_LOG_STORES = {
  /** One record per item with changes the server may lack, so tabs never race on a shared value */
  outbox: 'outbox',
  /** Log entries that couldn't be applied yet, by seq */
  parked: 'parked',
  /**
   * Reserved: first start's records, which nothing reads now. New databases don't create it, and
   * older ones keep theirs untouched. Kept because names never change.
   */
  firstStart: 'first-start',
  /**
   * Reserved: items with pulled changes no snapshot had confirmed, before they moved into each
   * item's record (`pulledAt`). New databases don't create it, and older ones keep theirs untouched.
   */
  unconfirmedPulls: 'unconfirmed-pulls',
  /** One record per item of what this device knows of the server's copy (see ItemSyncRecord) */
  items: 'items',
} as const

/** The stores the database creates and code reads: every name but the reserved ones */
export type SyncLogStoreName = Exclude<
  typeof SYNC_LOG_STORES[keyof typeof SYNC_LOG_STORES],
  typeof SYNC_LOG_STORES.firstStart | typeof SYNC_LOG_STORES.unconfirmedPulls
>

export function getSyncLogDatabaseName(accountId: string): string {
  return `${getVaultStorageNames().accountPrefixes.syncLogDatabase}${accountId}`
}

/** Deletes the account's sync log database. Close every connection to it first. */
export async function clearSyncLogStorage(accountId: string): Promise<void> {
  if (!accountId) return
  await deleteDatabase(getSyncLogDatabaseName(accountId))
}
