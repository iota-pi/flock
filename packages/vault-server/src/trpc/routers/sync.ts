import { protectedProcedure, router } from '../trpc'
import { PollLogSchema, SyncPollBatchSchema } from '@vault/shared'
import { pollSync } from '../../services/syncService'
import { pollLog } from '../../services/syncLogService'
import { InvalidPageTokenError } from '../../errors'
import { toTrpcError } from '../errors'


export const syncRouter = router({
  pollSync: protectedProcedure
    .input(SyncPollBatchSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await pollSync(ctx.vault, input)
      } catch (error) {
        throw toTrpcError(error, [
          { error: InvalidPageTokenError, code: 'BAD_REQUEST', message: e => e.message },
        ])
      }
    }),

  pollLog: protectedProcedure
    .input(PollLogSchema)
    .mutation(async ({ ctx, input }) => pollLog(ctx.vault, input)),
})
