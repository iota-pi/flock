import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'
import { setLastSyncServerTime } from '../../sync/syncServerTimeStore'
import { FetchItemsInputSchema } from '../../shared/syncSchemas'
import { assertSuccess } from './clientUtils'
import type {
  CachedVaultItem,
  ItemId,
  VaultItem,
} from './clientTypes'

export async function fetchMany(params: { cacheTime: number | null; ids?: never }): Promise<{ items: CachedVaultItem[]; serverTime: number }>
export async function fetchMany(params: { cacheTime?: never; ids: ItemId[] }): Promise<{ items: VaultItem[]; serverTime: number }>
export async function fetchMany({
  cacheTime,
  ids,
}: {
  cacheTime?: number | null
  ids?: ItemId[]
}): Promise<{ items: CachedVaultItem[] | VaultItem[]; serverTime: number }> {
  if (cacheTime !== undefined && ids) {
    throw new Error('Cannot use cacheTime and ids together')
  }
  if (cacheTime === undefined && !ids) {
    throw new Error('Must provide cacheTime or ids')
  }

  const account = getAccountId()
  const input = FetchItemsInputSchema.parse({
    account,
    cacheTime,
    ids,
  })
  const data = await trpcClient.items.fetchMany.query(input)
  assertSuccess(data, 'fetchMany')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  if (serverTime > 0) {
    setLastSyncServerTime(account, serverTime)
  }

  return {
    items: data.items as CachedVaultItem[] | VaultItem[],
    serverTime,
  }
}