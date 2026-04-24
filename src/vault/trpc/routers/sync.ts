import { protectedProcedure, router } from '../trpc'
import {
  SyncPullBatchSchema,
  SyncPullMessageSchema,
  SyncPushBatchSchema,
  SyncPushMessageSchema,
} from '../../../shared/schemas/trpc'
import { ACCOUNT_INDEX_DOCUMENT_ID } from '../../../sync/automergeConstants'
import {
  pullAutomergeSyncBatch,
  pullAutomergeSyncMessages,
  pushAutomergeSyncBatch,
  pushAutomergeSyncMessage,
} from '../../services/automergeSyncService'

export const syncRouter = router({
  pushMessage: protectedProcedure
    .input(SyncPushMessageSchema)
    .mutation(async ({ input }) => pushAutomergeSyncMessage(input)),

  pushBatch: protectedProcedure
    .input(SyncPushBatchSchema)
    .mutation(async ({ input }) => pushAutomergeSyncBatch(input)),

  pullMessage: protectedProcedure
    .input(SyncPullMessageSchema)
    .query(async ({ input }) => pullAutomergeSyncMessages(input)),

  pullBatch: protectedProcedure
    .input(SyncPullBatchSchema)
    .query(async ({ input }) => {
      const indexIndex = input.cursors.findIndex(c => c.itemId === ACCOUNT_INDEX_DOCUMENT_ID)
      if (indexIndex > 0) {
        const [indexCursor] = input.cursors.splice(indexIndex, 1)
        input.cursors.unshift(indexCursor)
      }
      return pullAutomergeSyncBatch(input)
    }),
})
