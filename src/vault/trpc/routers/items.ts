import { router, protectedProcedure } from '../trpc'
import {
  FetchItemsInputSchema,
} from '../schemas'
import {
  fetchItems,
} from '../../services/itemService'

export const itemsRouter = router({
  fetchMany: protectedProcedure
    .input(FetchItemsInputSchema)
    .query(async ({ ctx, input }) => {
      const result = await fetchItems(ctx, input)

      return {
        success: true,
        items: result.items,
        nextCursor: null,
        serverTime: result.serverTime,
      }
    }),
})
