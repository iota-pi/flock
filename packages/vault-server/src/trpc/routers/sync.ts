import { TRPCError } from '@trpc/server'
import { protectedProcedure, router } from '../trpc'
import { SyncPollBatchSchema, type ItemId, type PageToken } from '@vault/shared'
import { createAutomergeSyncService } from '../../services/automergeSyncService'
import { InvalidPageTokenError } from '../../drivers/errors'


export const syncRouter = router({
  pollSync: protectedProcedure
    .input(SyncPollBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const service = createAutomergeSyncService({ repository: ctx.vault })

      // Reject bad page tokens before storing any pushed messages, or the client would push them again
      try {
        if (input.globalPageToken) {
          ctx.vault.validatePageToken({ account: ctx.account, pageToken: input.globalPageToken })
        }
        for (const pullCursor of input.pullCursors) {
          if (pullCursor.pageToken) {
            ctx.vault.validatePageToken({
              account: ctx.account,
              itemId: pullCursor.itemId,
              cursor: pullCursor.cursor ?? 0,
              pageToken: pullCursor.pageToken,
            })
          }
        }
      } catch (error) {
        if (error instanceof InvalidPageTokenError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error })
        }
        throw error
      }

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
      let globalNextPageToken: PageToken | undefined = undefined
      let globalScannedThroughCursor: number | undefined = undefined

      const shouldPullBatch = input.pullCursors.length > 0
      const shouldPullGlobal = typeof input.clientLatestCursor === 'number' || !!input.globalPageToken

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
              pageToken: input.globalPageToken,
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
        globalNextPageToken = globalPullResult?.nextPageToken
        globalScannedThroughCursor = globalPullResult?.scannedThroughCursor
      }

      const hasMore = globalHasMore || pullResults.some(r => r.hasMore)

      return {
        success: true,
        pushResults,
        pullResults,
        hasMore,
        globalNextPageToken,
        globalHasMore: globalHasMore,
        globalScannedThroughCursor,
      }
    }),
})
