import { asItemType } from '../../drivers/base'
import { TransactionConflictsError } from '../../drivers/dynamo'
import { router, protectedProcedure } from '../trpc'
import {
  FetchItemsInputSchema,
  PutItemBodySchema,
  PutItemsBatchBodySchema,
} from '../schemas'

export const itemsRouter = router({
  fetchMany: protectedProcedure
    .input(FetchItemsInputSchema)
    .query(async ({ ctx, input }) => {
      const { account, cacheTime, ids } = input

      if (cacheTime !== undefined && ids && ids.length > 0) {
        throw new Error('Cannot use cacheTime and ids together')
      }

      const resultPromise = (
        cacheTime !== undefined || !ids || ids.length === 0
          ? ctx.vault.fetchAll({ account, cacheTime: cacheTime || undefined })
          : ctx.vault.fetchMany({ account, ids })
      )

      const items = await resultPromise
      return {
        success: true,
        items,
        nextCursor: null,
        serverTime: Date.now(),
      }
    }),

  putMany: protectedProcedure
    .input(PutItemsBatchBodySchema)
    .mutation(async ({ ctx, input }) => {
      const mappedItems = input.items.map(item => {
        const { cipher, deleted, id, iv, modified, type, version } = item
        const _type = asItemType(type)

        return {
          account: input.account,
          item: id,
          cipher,
          metadata: {
            type: _type,
            iv,
            modified,
            version,
            deleted,
          },
        }
      })

      try {
        await ctx.vault.setMany(mappedItems)
        return { success: true, conflicts: [] as string[] }
      } catch (error) {
        if (error instanceof TransactionConflictsError) {
          return {
            success: false,
            error: 'Version conflict' as const,
            conflicts: error.conflictedIds,
          }
        }
        throw error
      }
    }),

  put: protectedProcedure
    .input(PutItemBodySchema)
    .mutation(async ({ ctx, input }) => {
      const _type = asItemType(input.type)
      await ctx.vault.set({
        account: input.account,
        item: input.item,
        cipher: input.cipher,
        metadata: {
          type: _type,
          iv: input.iv,
          modified: input.modified,
          version: input.version,
          deleted: input.deleted,
        },
      })
      return { success: true }
    }),
})