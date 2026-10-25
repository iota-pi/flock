import {
  FetchItemsInputSchema,
  FetchSnapshotsByIdsInputSchema,
  type ManifestEntry,
  ItemId,
} from '@vault/shared'
import { assertSuccess } from './clientUtils'
import type { VaultItem } from './clientTypes'
import { getVaultTrpcClient } from './vaultTrpcClient'

export async function fetchManifest(
  { account }: { account: string },
  options?: { signal?: AbortSignal }
): Promise<{ manifest: Array<ManifestEntry>; serverTime: number }> {
  const input = FetchItemsInputSchema.parse({ account })
  const data = await getVaultTrpcClient().items.fetchManifest.query(input, options)
  assertSuccess(data, 'fetchManifest')
  return { manifest: data.manifest, serverTime: data.serverTime }
}

export async function fetchSnapshotsByIds(
  { account, itemIds }: { account: string; itemIds: ItemId[] },
  options?: { signal?: AbortSignal }
): Promise<{ items: VaultItem[]; serverTime: number }> {
  const input = FetchSnapshotsByIdsInputSchema.parse({ account, itemIds })
  const data = await getVaultTrpcClient().items.fetchSnapshotsByIds.query(input, options)
  assertSuccess(data, 'fetchSnapshotsByIds')
  // The server returns stored records (a plain string ID and an untyped snapshot cipher). This
  // narrows them to the envelope union, which nothing checks at runtime.
  return { items: data.items as VaultItem[], serverTime: data.serverTime }
}
