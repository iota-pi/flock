import { router, protectedProcedure } from '../trpc'
import {
  FetchItemsInputSchema,
  FetchSnapshotsByIdsInputSchema,
  PutSnapshotBatchSchema,
} from 'src/shared/schemas/trpc'
import {
  fetchManifest,
  fetchSnapshotsByIds,
} from '../../services/manifestService'
import type { VaultItem } from '../../drivers/base'
import type { ItemType } from '../../types'

export const itemsRouter = router({
  fetchManifest: protectedProcedure
    .input(FetchItemsInputSchema)
    .query(async ({ ctx, input }) => {
      const result = await fetchManifest(ctx, input)

      return {
        success: true,
        manifest: result.manifest,
        serverTime: result.serverTime,
      }
    }),

  fetchSnapshotsByIds: protectedProcedure
    .input(FetchSnapshotsByIdsInputSchema)
    .query(async ({ ctx, input }) => {
      const result = await fetchSnapshotsByIds(ctx, input)

      return {
        success: true,
        items: result.items,
        serverTime: result.serverTime,
      }
    }),


  putSnapshots: protectedProcedure
    .input(PutSnapshotBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const results = await Promise.allSettled(
        input.snapshots.map(async snapshot => {
          const item: VaultItem = {
            account: input.account,
            item: snapshot.itemId,
            metadata: {
              type: snapshot.type as ItemType,
              iv: '',
              modified: snapshot.modified,
              ...(snapshot.deleted ? { deleted: true } : {}),
            },
            snapshot: snapshot.snapshot,
          }

          await ctx.vault.set(item)
        })
      )

      const persistedSnapshots = results
        .map((result, index) => result.status === 'fulfilled' ? input.snapshots[index] : null)
        .filter((snapshot): snapshot is typeof input.snapshots[number] => !!snapshot)
      const persisted = persistedSnapshots.length

      if (persisted > 0) {
        const snapshotCursor = Math.max(...persistedSnapshots.map(snapshot => snapshot.snapshotCursor))
        await ctx.vault.updateAccountData({
          account: input.account,
          lastSnapshotCursor: snapshotCursor,
          lastSnapshotAt: Date.now(),
        })
      }

      return { success: true, persisted, total: input.snapshots.length }
    }),
})
