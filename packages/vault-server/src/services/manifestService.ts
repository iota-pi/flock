import type { VaultItem } from '../drivers/vaultDriver'
import type { FetchedItem, ItemId } from '@vault/shared'

/**
 * Narrows a stored row to the envelope clients read. A snapshot supersedes the legacy payload, so a
 * row with one never also sends `cipher` (a client would decode the older content and upload it).
 * Metadata passes through whole, because legacy rows keep fields the schema doesn't describe.
 */
export function toFetchedItem(record: VaultItem): FetchedItem {
  const base = { item: record.item as ItemId, metadata: record.metadata, version: record.version }
  if (record.snapshot) {
    const { cipher } = record.snapshot
    // Drivers return the ciphertext as base64 (the stored row's type also allows the binary form it
    // has at rest, which this narrows away). A row without one gets an empty string, which fails to
    // decrypt, so the client quarantines the item as it would any unreadable snapshot.
    return { ...base, snapshot: { ...record.snapshot, cipher: typeof cipher === 'string' ? cipher : '' } }
  }
  if (record.cipher) {
    return { ...base, cipher: record.cipher }
  }
  return base
}
