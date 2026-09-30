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
import { persistSnapshots } from '../../services/snapshotService'

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
      return persistSnapshots(ctx.vault, input)
    }),
})
