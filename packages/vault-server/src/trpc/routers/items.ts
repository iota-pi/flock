import { router, protectedProcedure } from '../trpc'
import { FetchSnapshotsByIdsInputSchema, PutSnapshotBatchSchema } from '@vault/shared'
import { limitFetchedItems, toFetchedItem } from '../../services/fetchedItem'
import { persistSnapshots } from '../../services/snapshotService'
import { QUOTA_EXCEEDED_MAPPING } from '../../quotas'
import { toTrpcError } from '../errors'

export const itemsRouter = router({
  fetchManifest: protectedProcedure
    .query(async ({ ctx, input }) => {
      const manifest = await ctx.vault.fetchManifest({ account: input.account })
      return { success: true, manifest, serverTime: Date.now() }
    }),

  fetchSnapshotsByIds: protectedProcedure
    .input(FetchSnapshotsByIdsInputSchema)
    .query(async ({ ctx, input }) => {
      const items = (await ctx.vault.fetchByIds({ account: input.account, itemIds: input.itemIds })).map(toFetchedItem)
      if (input.maxResponseChars === undefined) {
        return { success: true, items, serverTime: Date.now() }
      }
      const limited = limitFetchedItems(items, input.maxResponseChars)
      return { success: true, items: limited.items, deferred: limited.deferred, serverTime: Date.now() }
    }),

  putSnapshots: protectedProcedure
    .input(PutSnapshotBatchSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await persistSnapshots(ctx.vault, input, {
          usedBytes: ctx.accountData.storageBytes ?? 0,
          quotaBytes: ctx.quotas.storageBytes,
        })
      } catch (error) {
        throw toTrpcError(error, [QUOTA_EXCEEDED_MAPPING])
      }
    }),
})
