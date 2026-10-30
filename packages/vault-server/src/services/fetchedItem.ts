import type { FetchedVaultItem } from '../drivers/vaultDriver'
import type { FetchedItem, ItemId } from '@vault/shared'

/**
 * Narrows a stored row to the envelope clients read. A snapshot supersedes the legacy payload, so a
 * row with one never also sends `cipher` (a client would decode the older content and upload it).
 * Metadata passes through whole, because legacy rows keep fields the schema doesn't describe.
 */
export function toFetchedItem(record: FetchedVaultItem): FetchedItem {
  const base = { item: record.item as ItemId, metadata: record.metadata, version: record.version }
  if (record.snapshot) {
    // A snapshot without a ciphertext gets an empty string, which fails to decrypt, so the client
    // quarantines the item as it would any unreadable snapshot
    return { ...base, snapshot: { ...record.snapshot, cipher: record.snapshot.cipher ?? '' } }
  }
  if (record.cipher) {
    return { ...base, cipher: record.cipher }
  }
  return base
}
