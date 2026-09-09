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

      if (pushResults.length > 0) {
        const maxPushCursor = Math.max(...pushResults.map(result => result.cursor))
        const maxRetries = 3
        let currentAccount = await ctx.vault.getAccount({
          account: ctx.account,
          session: ctx.authToken,
        })
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if ((currentAccount.latestSyncCursor ?? 0) >= maxPushCursor) {
            break
          }
          try {
            await ctx.vault.updateAccountData({
              account: input.account,
              latestSyncCursor: maxPushCursor,
            })
            break
          } catch (err) {
            const isConditionalFailure =
              err instanceof Error && (
                err.name === 'ConditionalCheckFailedException'
                || err.message.includes('ConditionalCheckFailed')
                || err.message.includes('conditional request failed')
              )
            if (isConditionalFailure && attempt < maxRetries) {
              // Re-read account for latest cursor
              currentAccount = await ctx.vault.getAccount({ account: input.account, session: ctx.authToken })
              continue
            }
            throw err
          }
        }
      }

      return { success: true, pushResults, pullResults }
    }),
})
