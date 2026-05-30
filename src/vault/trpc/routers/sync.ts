import { protectedProcedure, router } from '../trpc'
import {
  SyncPushBatchSchema,
  SyncPollBatchSchema,
} from 'src/shared/schemas/trpc'
import { ACCOUNT_INDEX_DOCUMENT_ID } from 'src/sync/automergeConstants'
import {
  pullAutomergeSyncBatch,
  pushAutomergeSyncBatch,
} from '../../services/automergeSyncService'


const SNAPSHOT_REQUEST_INTERVAL = 30000

export const syncRouter = router({
  pushBatch: protectedProcedure
    .input(SyncPushBatchSchema)
    .mutation(async ({ input }) => pushAutomergeSyncBatch(input)),

  pollSync: protectedProcedure
    .input(SyncPollBatchSchema)
    .mutation(async ({ ctx, input }) => {
      let pushResults: Array<{ itemId: string; cursor: number }> = []
      if (input.pushMessages.length > 0) {
        const pushResult = await pushAutomergeSyncBatch({
          account: input.account,
          messages: input.pushMessages,
        })
        pushResults = pushResult.results
      }

      let pullResults: Awaited<ReturnType<typeof pullAutomergeSyncBatch>>['results'] = []
      if (input.pullCursors.length > 0) {
        const indexIndex = input.pullCursors.findIndex(c => c.itemId === ACCOUNT_INDEX_DOCUMENT_ID)
        if (indexIndex > 0) {
          const [indexCursor] = input.pullCursors.splice(indexIndex, 1)
          input.pullCursors.unshift(indexCursor)
        }

        const pullResult = await pullAutomergeSyncBatch({
          account: input.account,
          cursors: input.pullCursors,
        })
        pullResults = pullResult.results
      }

      let snapshotRequest: { requested: true; cursor: number; requestedAt: number } | undefined
      if (pushResults.length > 0) {
        const account = await ctx.vault.getAccount({
          account: input.account,
          session: ctx.authToken,
        })
        const now = Date.now()
        const lastRequestedAt = account.lastSnapshotRequestedAt ?? 0
        if (now - lastRequestedAt >= SNAPSHOT_REQUEST_INTERVAL) {
          const cursor = Math.max(...pushResults.map(result => result.cursor))
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
