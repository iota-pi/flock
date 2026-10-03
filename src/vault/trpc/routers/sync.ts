import { TRPCError } from '@trpc/server'
import { protectedProcedure, router } from '../trpc'
import {
  SyncPushBatchSchema,
  SyncPollBatchSchema,
  type GlobalSyncLastEvaluatedKey,
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
      if (input.globalLastEvaluatedKey) {
        if (input.globalLastEvaluatedKey.account !== ctx.account) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'globalLastEvaluatedKey account mismatch',
          })
        }
        if (!input.globalLastEvaluatedKey.syncId.startsWith(`${ctx.account}#`)) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'globalLastEvaluatedKey syncId mismatch',
          })
        }
        const clientLatestCursor = input.clientLatestCursor ?? 0
        if (input.globalLastEvaluatedKey.cursor < clientLatestCursor) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'globalLastEvaluatedKey cursor cannot precede clientLatestCursor',
          })
        }
      }

      for (const pullCursor of input.pullCursors) {
        if (pullCursor.lastEvaluatedKey) {
          const expectedSyncId = `${ctx.account}#${pullCursor.itemId}`
          if (pullCursor.lastEvaluatedKey.syncId !== expectedSyncId) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `pullCursor lastEvaluatedKey syncId mismatch for item ${pullCursor.itemId}`,
            })
          }
          const baseCursor = pullCursor.cursor ?? 0
          if (pullCursor.lastEvaluatedKey.cursor < baseCursor) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `pullCursor lastEvaluatedKey cursor cannot precede pull cursor for item ${pullCursor.itemId}`,
            })
          }
        }
      }

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
      let globalHasMore = false
      let globalLastEvaluatedKey: GlobalSyncLastEvaluatedKey | undefined = undefined

      const shouldPullBatch = input.pullCursors.length > 0
      const shouldPullGlobal = typeof input.clientLatestCursor === 'number' || !!input.globalLastEvaluatedKey

      if (shouldPullBatch || shouldPullGlobal) {
        const [batchPullResult, globalPullResult] = await Promise.all([
          shouldPullBatch
            ? service.pullAutomergeSyncBatch({
              account: ctx.account,
              cursors: input.pullCursors,
            })
            : null,
          shouldPullGlobal
            ? service.pullAutomergeSyncGlobal({
              account: ctx.account,
              cursor: input.clientLatestCursor ?? 0,
              lastEvaluatedKey: input.globalLastEvaluatedKey,
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
        globalHasMore = globalPullResult?.hasMore ?? false
        globalLastEvaluatedKey = globalPullResult?.lastEvaluatedKey
      }

      const hasMore = globalHasMore || pullResults.some(r => r.hasMore)

      return { success: true, pushResults, pullResults, hasMore, globalLastEvaluatedKey }
    }),
})
