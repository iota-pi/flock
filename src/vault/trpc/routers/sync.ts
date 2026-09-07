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

      if (typeof input.clientLatestCursor === 'number') {
        const pullResult = await service.pullAutomergeSyncGlobal({
          account: input.account,
          cursor: input.clientLatestCursor,
        })
        pullResults = pullResult.results
      } else if (input.pullCursors.length > 0) {
        const pullResult = await service.pullAutomergeSyncBatch({
          account: input.account,
          cursors: input.pullCursors,
        })
        pullResults = pullResult.results
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
