import { router, protectedProcedure } from '../trpc'
import { FetchSnapshotsByIdsInputSchema, PutSnapshotBatchSchema } from '@vault/shared'
import { toFetchedItem } from '../../services/fetchedItem'
import { persistSnapshots } from '../../services/snapshotService'

export const itemsRouter = router({
  fetchManifest: protectedProcedure
    .query(async ({ ctx, input }) => {
      const manifest = await ctx.vault.fetchManifest({ account: input.account })
      return { success: true, manifest, serverTime: Date.now() }
    }),

  fetchSnapshotsByIds: protectedProcedure
    .input(FetchSnapshotsByIdsInputSchema)
    .query(async ({ ctx, input }) => {
      const items = await ctx.vault.fetchByIds({ account: input.account, itemIds: input.itemIds })
      return { success: true, items: items.map(toFetchedItem), serverTime: Date.now() }
    }),

  putSnapshots: protectedProcedure
    .input(PutSnapshotBatchSchema)
    .mutation(async ({ ctx, input }) => {
      return persistSnapshots(ctx.vault, input)
    }),
})
