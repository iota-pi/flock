import type BaseDriver from '../drivers/base'
import type { VaultItem } from '../drivers/base'
import type { ItemId } from 'src/shared/schemas/items'

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

export async function fetchItemsMetadata(
  ctx: ItemServiceContext,
  input: { account: string },
): Promise<{ items: Array<{ itemId: ItemId; modified: number; deleted: boolean; type: string }>; serverTime: number }> {
  const { account } = input
  const items = await ctx.vault.fetchMetadataAll({ account })

  return {
    items: items.map(i => ({
      itemId: i.item as ItemId,
      modified: i.metadata.modified,
      deleted: !!i.metadata.deleted,
      type: i.metadata.type,
    })),
    serverTime: Date.now(),
  }
}
