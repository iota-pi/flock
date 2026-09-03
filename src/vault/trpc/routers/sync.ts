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
      return service.pushAutomergeSyncBatch(input)
    }),

  pollSync: protectedProcedure
    .input(SyncPollBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const repository = createDynamoAutomergeSyncRepository(ctx.vault)
      const service = createAutomergeSyncService({ repository })

      const account = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })

      let pushResults: Array<{ itemId: ItemId; cursor: number }> = []
      if (input.pushMessages.length > 0) {
        const pushResult = await service.pushAutomergeSyncBatch({
          account: input.account,
          messages: input.pushMessages,
        })
        pushResults = pushResult.results
      }

      let pullResults: Awaited<ReturnType<typeof service.pullAutomergeSyncBatch>>['results'] = []
      
      if (typeof input.clientLatestCursor === 'number') {
        if (input.clientLatestCursor > 0 && input.clientLatestCursor >= (account.latestSyncCursor ?? 0)) {
          // Fast Path: Client is fully up to date globally, skip database query
          pullResults = []
        } else {
          const pullResult = await service.pullAutomergeSyncGlobal({
            account: input.account,
            cursor: input.clientLatestCursor,
          })
          pullResults = pullResult.results
        }
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
        let currentAccount = account
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            await ctx.vault.updateAccountData({
              account: input.account,
              latestSyncCursor: Math.max(maxPushCursor, currentAccount.latestSyncCursor ?? 0),
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
