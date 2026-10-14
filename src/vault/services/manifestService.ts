import type BaseDriver from '../drivers/base'
import type { VaultItem } from '../drivers/base'
import type { ItemId } from 'src/shared/vault/ids'
import type { ManifestEntry } from 'src/shared/vault/api'

type ManifestServiceContext = {
  vault: BaseDriver
}

export async function fetchManifest(
  ctx: ManifestServiceContext,
  input: { account: string },
): Promise<{ manifest: ManifestEntry[]; serverTime: number }> {
  const { account } = input
  const manifest = await ctx.vault.fetchManifest({ account })

  return {
    manifest,
    serverTime: Date.now(),
  }
}

export async function fetchSnapshotsByIds(
  ctx: ManifestServiceContext,
  input: { account: string; itemIds: ItemId[] },
): Promise<{ items: VaultItem[]; serverTime: number }> {
  const { account, itemIds } = input
  const items = await ctx.vault.fetchByIds({ account, itemIds })

  return {
    items,
    serverTime: Date.now(),
  }
}
