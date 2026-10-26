import type { VaultItem, VaultDriver } from '../drivers/vaultDriver'
import type { FetchedItem, ItemId, ManifestEntry } from '@vault/shared'

type ManifestServiceContext = {
  vault: VaultDriver
}

export async function fetchManifest(
  ctx: ManifestServiceContext,
  input: { account: string },
): Promise<{ manifest: ManifestEntry[]; serverTime: number }> {
  const { account } = input
  const manifest = await ctx.vault.fetchManifest({ account })

  return {
    manifest,
    serverTime: Date.now(),
  }
}

export async function fetchSnapshotsByIds(
  ctx: ManifestServiceContext,
  input: { account: string; itemIds: ItemId[] },
): Promise<{ items: FetchedItem[]; serverTime: number }> {
  const { account, itemIds } = input
  const items = await ctx.vault.fetchByIds({ account, itemIds })

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
    // The driver returns the ciphertext as base64. A row without one gets an empty string, which
    // fails to decrypt, so the client quarantines the item as it would any unreadable snapshot.
    return { ...base, snapshot: { ...record.snapshot, cipher: typeof cipher === 'string' ? cipher : '' } }
  }
  if (record.cipher) {
    return { ...base, cipher: record.cipher }
  }
  return base
}
