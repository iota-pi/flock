import type BaseDriver from '../drivers/base'
import type { VaultItem } from '../drivers/base'
import type { ItemId } from '../../shared/itemTypes'

type ItemServiceContext = {
  vault: BaseDriver
}

export async function fetchItems(
  ctx: ItemServiceContext,
  input: { account: string; cacheTime?: number | null; ids?: ItemId[] },
): Promise<{ items: VaultItem[]; serverTime: number }> {
  const { account, cacheTime, ids } = input

  if (cacheTime !== undefined && ids && ids.length > 0) {
    throw new Error('Cannot use cacheTime and ids together')
  }

  const resultPromise = (
    cacheTime !== undefined || !ids || ids.length === 0
      ? ctx.vault.fetchAll({ account, cacheTime: cacheTime || undefined })
      : ctx.vault.fetchMany({ account, ids })
  )

  const items = await resultPromise
  const finalItems = typeof cacheTime === 'number'
    ? items
    : items.filter(item => item.metadata?.deleted !== true)

  return {
    items: finalItems as VaultItem[],
    serverTime: Date.now(),
  }
}
