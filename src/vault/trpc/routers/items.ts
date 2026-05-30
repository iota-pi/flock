import { router, protectedProcedure } from '../trpc'
import {
  FetchItemsInputSchema,
  PutSnapshotBatchSchema,
} from 'src/shared/schemas/trpc'
import {
  fetchItems,
} from '../../services/itemService'
import type { VaultItem } from '../../drivers/base'
import type { ItemType } from '../../types'


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

  putSnapshots: protectedProcedure
    .input(PutSnapshotBatchSchema)
    .mutation(async ({ ctx, input }) => {
      const results = await Promise.allSettled(
        input.snapshots.map(async snapshot => {
          const item: VaultItem = {
            account: input.account,
            item: snapshot.itemId,
            metadata: {
              type: snapshot.type as ItemType,
              iv: '',
              modified: snapshot.modified,
              ...(snapshot.deleted ? { deleted: true } : {}),
            },
            snapshot: snapshot.snapshot,
          }

          await ctx.vault.set(item)
        })
      )

      const persisted = results.filter(result => result.status === 'fulfilled').length

      return { success: true, persisted, total: input.snapshots.length }
    }),
})
