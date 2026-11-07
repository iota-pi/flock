import type { FetchedVaultItem } from '../drivers/vaultDriver'
import type { FetchedItem, ItemId } from '@vault/shared'

/**
 * Narrows a stored row to the envelope clients read. A snapshot supersedes the legacy payload, so a
 * row with one never also sends `cipher` (a client would decode the older content and upload it).
 * Metadata passes through whole, because legacy rows keep fields the schema doesn't describe.
 */
/** Roughly how many characters an item adds to a response: its ciphertexts, which dominate */
export function fetchedItemChars(item: FetchedItem): number {
  const { cipher, snapshot, heads } = item as FetchedItem & { cipher?: string, heads?: { cipher?: string } }
  return (cipher?.length ?? 0) + (snapshot?.cipher.length ?? 0) + (heads?.cipher?.length ?? 0)
}

/**
 * Splits items, in order, into those that fit in `maxChars` (always at least one, since an item
 * alone is well under the limit) and the IDs of the rest
 */
export function limitFetchedItems(items: FetchedItem[], maxChars: number): { items: FetchedItem[], deferred: ItemId[] } {
  let chars = 0
  let count = 0
  for (const item of items) {
    chars += fetchedItemChars(item)
    if (count > 0 && chars > maxChars) break
    count += 1
  }
  return { items: items.slice(0, count), deferred: items.slice(count).map(item => item.item) }
}

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
