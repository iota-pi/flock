import { asItemType } from '../../drivers/base'
import { TransactionConflictsError } from '../../drivers/dynamo'
import { publishRealtimeEvent } from '../../realtime/hub'
import { router, protectedProcedure } from '../trpc'
import {
  FetchItemsInputSchema,
  PutItemBodySchema,
  PutItemsBatchBodySchema,
} from '../schemas'

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000
const processedIdempotencyKeys = new Map<string, number>()

function pruneExpiredIdempotencyKeys() {
  const now = Date.now()
  for (const [key, timestamp] of processedIdempotencyKeys.entries()) {
    if (now - timestamp > IDEMPOTENCY_TTL_MS) {
      processedIdempotencyKeys.delete(key)
    }
  }
}

function hasProcessedIdempotencyKey(idempotencyKey?: string): boolean {
  if (!idempotencyKey) {
    return false
  }

  pruneExpiredIdempotencyKeys()
  return processedIdempotencyKeys.has(idempotencyKey)
}

function markIdempotencyKeyProcessed(idempotencyKey?: string): void {
  if (!idempotencyKey) {
    return
  }

  pruneExpiredIdempotencyKeys()
  processedIdempotencyKeys.set(idempotencyKey, Date.now())
}

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
      const finalItems = typeof cacheTime === 'number'
        ? items
        : items.filter(item => item.metadata?.deleted !== true)

      return {
        success: true,
        items: finalItems,
        nextCursor: null,
        serverTime: Date.now(),
      }
    }),

  putMany: protectedProcedure
    .input(PutItemsBatchBodySchema)
    .mutation(async ({ ctx, input }) => {
      if (hasProcessedIdempotencyKey(input.idempotencyKey)) {
        return { success: true, conflicts: [] as string[] }
      }

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
        await publishRealtimeEvent(input.account, 'items.updated', {
          itemIds: input.items.map(item => item.id),
          count: input.items.length,
        })
        markIdempotencyKeyProcessed(input.idempotencyKey)
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
      if (hasProcessedIdempotencyKey(input.idempotencyKey)) {
        return { success: true }
      }

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
      await publishRealtimeEvent(input.account, 'items.updated', {
        itemIds: [input.item],
        count: 1,
      })
      markIdempotencyKeyProcessed(input.idempotencyKey)
      return { success: true }
    }),
})