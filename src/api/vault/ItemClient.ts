import { FetchItemsInputSchema, FetchSnapshotsByIdsInputSchema } from '../../shared/schemas/trpc'
import { assertSuccess } from './clientUtils'
import type { VaultItem } from './clientTypes'
import type { ItemId } from '../../shared/schemas/items'
import { getTrpcClient } from '../trpcClient'


export type ManifestEntry = [string, number, boolean?]

export async function fetchManifest(
  { account }: { account: string },
  options?: { signal?: AbortSignal }
): Promise<{ manifest: Array<ManifestEntry>; serverTime: number }> {
  const input = FetchItemsInputSchema.parse({ account })
  const data = await getTrpcClient().items.fetchManifest.query(input, options?.signal ? { signal: options.signal } : undefined)
  assertSuccess(data, 'fetchManifest')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  return {
    manifest: data.manifest as Array<ManifestEntry>,
    serverTime,
  }
}

export async function fetchSnapshotsByIds(
  { account, itemIds }: { account: string; itemIds: ItemId[] },
  options?: { signal?: AbortSignal }
): Promise<{ items: VaultItem[]; serverTime: number }> {
  const input = FetchSnapshotsByIdsInputSchema.parse({ account, itemIds })
  const data = await getTrpcClient().items.fetchSnapshotsByIds.query(input, options?.signal ? { signal: options.signal } : undefined)
  assertSuccess(data, 'fetchSnapshotsByIds')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  return {
    items: data.items as VaultItem[],
    serverTime,
  }
}
