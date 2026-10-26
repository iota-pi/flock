import type { VaultItem, VaultDriver } from '../drivers/vaultDriver'
import type { FetchedItem, ItemId, ManifestEntry } from '@vault/shared'

export async function fetchManifest(
  vault: VaultDriver,
  input: { account: string },
): Promise<{ manifest: ManifestEntry[]; serverTime: number }> {
  const manifest = await vault.fetchManifest({ account: input.account })

  return {
    manifest,
    serverTime: Date.now(),
  }
}

export async function fetchSnapshotsByIds(
  vault: VaultDriver,
  input: { account: string; itemIds: ItemId[] },
): Promise<{ items: FetchedItem[]; serverTime: number }> {
  const items = await vault.fetchByIds({ account: input.account, itemIds: input.itemIds })

  return {
    items: items.map(toFetchedItem),
    serverTime: Date.now(),
  }
}

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
