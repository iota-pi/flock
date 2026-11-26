import { PollLogSchema } from '@vault/shared'
import { protectedProcedure, router } from '../trpc'
import { pollLog } from '../../services/syncLogService'
import { QUOTA_EXCEEDED_MAPPING } from '../../quotas'
import { toTrpcError, type TrpcErrorMapping } from '../errors'
import { PushTooLargeError } from '../../errors'

const PUSH_TOO_LARGE_MAPPING: TrpcErrorMapping = { error: PushTooLargeError, code: 'PAYLOAD_TOO_LARGE' }


export const syncRouter = router({
  pollLog: protectedProcedure
    .input(PollLogSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await pollLog(ctx.vault, input, ctx.quotas)
      } catch (error) {
        throw toTrpcError(error, [QUOTA_EXCEEDED_MAPPING, PUSH_TOO_LARGE_MAPPING])
      }
    }),
})
