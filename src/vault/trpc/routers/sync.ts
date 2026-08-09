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

      const account = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })
      const now = Date.now()

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
        if (input.clientLatestCursor >= (account.latestSyncCursor ?? 0)) {
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

      const maxPushCursor = pushResults.length > 0
        ? Math.max(...pushResults.map(result => result.cursor))
        : 0

      let snapshotRequest: { requested: true; cursor: number; requestedAt: number } | undefined
      let shouldUpdateAccount = false
      if (pushResults.length > 0 || pullResults.length > 0) {
        const lastRequestedAt = account.lastSnapshotRequestedAt ?? 0
        const lastSnapshotAt = account.lastSnapshotAt ?? 0
        const isSnapshotStale = now - lastSnapshotAt >= SNAPSHOT_REFRESH_INTERVAL
        const shouldRequestSnapshot = (pushResults.length > 0 || isSnapshotStale)
          && now - lastRequestedAt >= SNAPSHOT_REQUEST_INTERVAL

        if (shouldRequestSnapshot) {
          const cursor = pushResults.length > 0
            ? maxPushCursor
            : (account.lastSnapshotCursor ?? 0)
          snapshotRequest = { requested: true, cursor, requestedAt: now }
          shouldUpdateAccount = true
        }
      }

      if (pushResults.length > 0) {
        shouldUpdateAccount = true
      }

      if (shouldUpdateAccount) {
        await ctx.vault.updateAccountData({
          account: input.account,
          ...(snapshotRequest ? { lastSnapshotRequestedAt: now } : {}),
          ...(pushResults.length > 0 ? { latestSyncCursor: maxPushCursor } : {}),
        })
      }

      return { success: true, pushResults, pullResults, snapshotRequest }
    }),
})
