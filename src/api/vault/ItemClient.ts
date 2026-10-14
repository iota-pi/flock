import { FetchItemsInputSchema, FetchSnapshotsByIdsInputSchema, type ManifestEntry } from '../../shared/vault/api'
import { assertSuccess } from './clientUtils'
import type { VaultItem } from './clientTypes'
import type { ItemId } from '../../shared/vault/ids'
import { getVaultTrpcClient } from '../vaultTrpcClient'

export async function fetchManifest(
  { account }: { account: string },
  options?: { signal?: AbortSignal }
): Promise<{ manifest: Array<ManifestEntry>; serverTime: number }> {
  const input = FetchItemsInputSchema.parse({ account })
  const data = await getVaultTrpcClient().items.fetchManifest.query(input, options?.signal ? { signal: options.signal } : undefined)
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
  const data = await getVaultTrpcClient().items.fetchSnapshotsByIds.query(input, options?.signal ? { signal: options.signal } : undefined)
  assertSuccess(data, 'fetchSnapshotsByIds')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  return {
    items: data.items as VaultItem[],
    serverTime,
  }
}
