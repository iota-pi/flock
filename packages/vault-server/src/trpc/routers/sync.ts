import { TRPCError } from '@trpc/server'
import { CLIENT_OUTDATED_MESSAGE, PollLogSchema } from '@vault/shared'
import { protectedProcedure, publicProcedure, router } from '../trpc'
import { pollLog } from '../../services/syncLogService'


export const syncRouter = router({
  /**
   * Removed, but kept as a stub for builds from before the sync log. A removed procedure answers
   * NOT_FOUND, which they treat as a failed poll, so they would never learn to update.
   */
  pollSync: publicProcedure
    .mutation(() => {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: CLIENT_OUTDATED_MESSAGE })
    }),

  pollLog: protectedProcedure
    .input(PollLogSchema)
    .mutation(async ({ ctx, input }) => pollLog(ctx.vault, input)),
})
