import { protectedProcedure, router } from '../trpc'
import {
  SyncPushBatchSchema,
  SyncPollBatchSchema,
} from 'src/shared/schemas/trpc'
import { createAutomergeSyncService } from '../../services/automergeSyncService'
import { createDynamoAutomergeSyncRepository } from '../../services/automergeSyncRepository'
import { ItemId } from 'src/shared/schemas/items'


const SNAPSHOT_REQUEST_INTERVAL = 30000
const SNAPSHOT_REFRESH_INTERVAL = 24 * 60 * 60 * 1000

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

      let pushResults: Array<{ itemId: ItemId; cursor: number }> = []
      if (input.pushMessages.length > 0) {
        const pushResult = await service.pushAutomergeSyncBatch({
          account: input.account,
          messages: input.pushMessages,
        })
        pushResults = pushResult.results
      }

      let pullResults: Awaited<ReturnType<typeof service.pullAutomergeSyncBatch>>['results'] = []
      if (input.pullCursors.length > 0) {
        const pullResult = await service.pullAutomergeSyncBatch({
          account: input.account,
          cursors: input.pullCursors,
        })
        pullResults = pullResult.results
      }

      let snapshotRequest: { requested: true; cursor: number; requestedAt: number } | undefined
      if (pushResults.length > 0 || input.pullCursors.length > 0) {
        const account = await ctx.vault.getAccount({
          account: input.account,
          session: ctx.authToken,
        })
        const now = Date.now()
        const lastRequestedAt = account.lastSnapshotRequestedAt ?? 0
        const lastSnapshotAt = account.lastSnapshotAt ?? 0
        const isSnapshotStale = now - lastSnapshotAt >= SNAPSHOT_REFRESH_INTERVAL
        const shouldRequestSnapshot = (pushResults.length > 0 || isSnapshotStale)
          && now - lastRequestedAt >= SNAPSHOT_REQUEST_INTERVAL

        if (shouldRequestSnapshot) {
          const cursor = pushResults.length > 0
            ? Math.max(...pushResults.map(result => result.cursor))
            : (account.lastSnapshotCursor ?? 0)
          snapshotRequest = { requested: true, cursor, requestedAt: now }
          await ctx.vault.updateAccountData({
            account: input.account,
            lastSnapshotRequestedAt: now,
          })
        }
      }

      return { success: true, pushResults, pullResults, snapshotRequest }
    }),
})
