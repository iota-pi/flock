import { protectedProcedure, router } from '../trpc'
import {
  SyncPullBatchSchema,
  SyncPullMessageSchema,
  SyncPushBatchSchema,
  SyncPushMessageSchema,
} from '../../../shared/schemas/trpc'
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
    .query(async ({ input }) => pullAutomergeSyncBatch(input)),
})
