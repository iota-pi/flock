import type BaseDriver from '../drivers/base'
import type { VaultItem } from '../drivers/base'

type ManifestServiceContext = {
  vault: BaseDriver
}

export async function fetchManifest(
  ctx: ManifestServiceContext,
  input: { account: string },
): Promise<{ manifest: Array<[string, number]>; serverTime: number }> {
  const { account } = input
  const items = await ctx.vault.fetchManifest({ account })

  return {
    manifest: items.map(entry => [entry.itemId, entry.modifiedAt]),
    serverTime: Date.now(),
  }
}

export async function fetchSnapshotsByIds(
  ctx: ManifestServiceContext,
  input: { account: string; itemIds: string[] },
): Promise<{ items: VaultItem[]; serverTime: number }> {
  const { account, itemIds } = input
  const items = await ctx.vault.fetchByIds({ account, itemIds })

  return {
    items,
    serverTime: Date.now(),
  }
}
