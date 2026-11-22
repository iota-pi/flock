import { PollLogSchema } from '@vault/shared'
import { protectedProcedure, router } from '../trpc'
import { pollLog } from '../../services/syncLogService'
import { QUOTA_EXCEEDED_MAPPING } from '../../quotas'
import { toTrpcError } from '../errors'


export const syncRouter = router({
  pollLog: protectedProcedure
    .input(PollLogSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await pollLog(ctx.vault, input, ctx.quotas)
      } catch (error) {
        throw toTrpcError(error, [QUOTA_EXCEEDED_MAPPING])
      }
    }),
})
