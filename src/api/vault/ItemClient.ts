import { FetchItemsInputSchema, FetchSnapshotsByIdsInputSchema } from '../../shared/schemas/trpc'
import { assertSuccess } from './clientUtils'
import type { VaultItem } from './clientTypes'
import type { ItemId } from '../../shared/schemas/items'
import { getTrpcClient } from '../trpcClient'


export async function fetchManifest({ account }: { account: string }): Promise<{ manifest: Array<[string, number]>; serverTime: number }> {
  const input = FetchItemsInputSchema.parse({ account })
  const data = await getTrpcClient().items.fetchManifest.query(input)
  assertSuccess(data, 'fetchManifest')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  return {
    manifest: data.manifest as Array<[string, number]>,
    serverTime,
  }
}

export async function fetchSnapshotsByIds({ account, itemIds }: { account: string; itemIds: ItemId[] }): Promise<{ items: VaultItem[]; serverTime: number }> {
  const input = FetchSnapshotsByIdsInputSchema.parse({ account, itemIds })
  const data = await getTrpcClient().items.fetchSnapshotsByIds.query(input)
  assertSuccess(data, 'fetchSnapshotsByIds')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  return {
    items: data.items as VaultItem[],
    serverTime,
  }
}
