import { protectedProcedure, router } from '../trpc'
import {
  SyncPushBatchSchema,
  SyncPollBatchSchema,
} from '../../../shared/schemas/trpc'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../../../sync/automergeConstants'
import {
  pullAutomergeSyncBatch,
  pushAutomergeSyncBatch,
} from '../../services/automergeSyncService'

export const syncRouter = router({
  pushBatch: protectedProcedure
    .input(SyncPushBatchSchema)
    .mutation(async ({ input }) => pushAutomergeSyncBatch(input)),

  pollSync: protectedProcedure
    .input(SyncPollBatchSchema)
    .mutation(async ({ input }) => {
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

      return { success: true, pushResults, pullResults }
    }),
})
