import pMap from 'p-map'
import { asItemType } from '../../drivers/base'
import { router, protectedProcedure } from '../trpc'
import {
  DeleteItemBodySchema,
  DeleteItemsBatchBodySchema,
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
      return { success: true, items }
    }),

  putMany: protectedProcedure
    .input(PutItemsBatchBodySchema)
    .mutation(async ({ ctx, input }) => {
      const results = await pMap(
        input.items,
        async item => {
          const { cipher, id, iv, modified, type, version } = item
          const _type = asItemType(type)

          try {
            await ctx.vault.set({
              account: input.account,
              item: id,
              cipher,
              metadata: {
                type: _type,
                iv,
                modified,
                version,
              },
            })
            return { item: id, success: true }
          } catch (error) {
            return {
              item: id,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        },
        { concurrency: 10 },
      )

      return { success: true, details: results }
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
        },
      })
      return { success: true }
    }),

  deleteMany: protectedProcedure
    .input(DeleteItemsBatchBodySchema)
    .mutation(async ({ ctx, input }) => {
      const results = await pMap(
        input.items,
        async item => {
          try {
            await ctx.vault.delete({ account: input.account, item })
            return { item, success: true }
          } catch (error) {
            return {
              item,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        },
        { concurrency: 10 },
      )

      return { success: true, details: results }
    }),

  delete: protectedProcedure
    .input(DeleteItemBodySchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.vault.delete({ account: input.account, item: input.item })
      return { success: true }
    }),
})