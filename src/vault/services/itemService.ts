import type BaseDriver from '../drivers/base'
import type { VaultItem } from '../drivers/base'


type ItemServiceContext = {
  vault: BaseDriver
}

export async function fetchItems(
  ctx: ItemServiceContext,
  input: { account: string },
): Promise<{ items: VaultItem[]; serverTime: number }> {
  const { account } = input
  const items = await ctx.vault.fetchAll({ account })

  return {
    items,
    serverTime: Date.now(),
  }
}
