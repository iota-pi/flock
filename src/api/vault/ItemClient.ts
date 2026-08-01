import { FetchItemsInputSchema } from '../../shared/schemas/trpc'
import { assertSuccess } from './clientUtils'
import type { VaultItem } from './clientTypes'
import { getTrpcClient } from '../trpcClient'

export async function fetchMany({ account }: { account: string }): Promise<{ items: VaultItem[]; serverTime: number }> {
  const input = FetchItemsInputSchema.parse({ account })
  const data = await getTrpcClient().items.fetchMany.query(input)
  assertSuccess(data, 'fetchMany')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  return {
    items: data.items as VaultItem[],
    serverTime,
  }
}
