import { protectedProcedure, router } from '../trpc'
import {
  SyncPushBatchSchema,
  SyncPollBatchSchema,
} from 'src/shared/schemas/trpc'
import { createAutomergeSyncService } from '../../services/automergeSyncService'
import { createDynamoAutomergeSyncRepository } from '../../services/automergeSyncRepository'
import { ItemId } from 'src/shared/schemas/items'


export const syncRouter = router({
  pushBatch: protectedProcedure
    .input(SyncPushBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = createDynamoAutomergeSyncRepository(ctx.vault)
      const service = createAutomergeSyncService({ repository })
      return service.pushAutomergeSyncBatch({
        ...input,
        account: ctx.account,
      })
    }),

  pollSync: protectedProcedure
    .input(SyncPollBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = createDynamoAutomergeSyncRepository(ctx.vault)
      const service = createAutomergeSyncService({ repository })

      let pushResults: Array<{ itemId: ItemId; cursor: number }> = []
      if (input.pushMessages.length > 0) {
        const pushResult = await service.pushAutomergeSyncBatch({
          account: ctx.account,
          messages: input.pushMessages,
        })
        pushResults = pushResult.results
      }

      let pullResults: Awaited<ReturnType<typeof service.pullAutomergeSyncBatch>>['results'] = []

      const shouldPullBatch = input.pullCursors.length > 0
      const shouldPullGlobal = typeof input.clientLatestCursor === 'number'

      if (shouldPullBatch || shouldPullGlobal) {
        const [batchPullResult, globalPullResult] = await Promise.all([
          shouldPullBatch
            ? service.pullAutomergeSyncBatch({
                account: input.account,
                cursors: input.pullCursors,
              })
            : null,
          shouldPullGlobal
            ? service.pullAutomergeSyncGlobal({
                account: input.account,
                cursor: input.clientLatestCursor!,
              })
            : null,
        ])

        const batchResults = batchPullResult ? batchPullResult.results : []
        const pullCursorItemIds = new Set(input.pullCursors.map(c => c.itemId))

        // Filter out items in pullCursors from global results to prevent cursor jumps
        // and missing message gaps while lagging items catch up sequentially.
        const filteredGlobalResults = globalPullResult
          ? (pullCursorItemIds.size > 0
              ? globalPullResult.results.filter(r => !pullCursorItemIds.has(r.itemId))
              : globalPullResult.results)
          : []

        pullResults = [...batchResults, ...filteredGlobalResults]
      }

      return { success: true, pushResults, pullResults }
    }),
})
