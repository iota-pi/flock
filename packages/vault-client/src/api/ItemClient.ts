import {
  FetchItemsInputSchema,
  FetchSnapshotsByIdsInputSchema,
  type FetchedItem,
  type ManifestEntry,
  ItemId,
} from '@vault/shared'
import { assertSuccess } from './clientUtils'
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
): Promise<{ items: FetchedItem[]; serverTime: number }> {
  const input = FetchSnapshotsByIdsInputSchema.parse({ account, itemIds })
  const data = await getVaultTrpcClient().items.fetchSnapshotsByIds.query(input, options)
  assertSuccess(data, 'fetchSnapshotsByIds')
  return { items: data.items, serverTime: data.serverTime }
}
