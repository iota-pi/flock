import { asItemType } from '../../drivers/base'
import { TransactionConflictsError } from '../../drivers/dynamo'
import { publishRealtimeEvent } from '../../realtime/hub'
import { router, protectedProcedure } from '../trpc'
import {
  FetchItemHistoryInputSchema,
  FetchItemsInputSchema,
  PutItemBodySchema,
  PutItemsBatchBodySchema,
  ResolveBatchConflictsSchema,
} from '../schemas'
import type { VaultBranch } from '../../../shared/itemTypes'

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000
const HISTORY_RETENTION_SECONDS = 30 * 24 * 60 * 60
const processedIdempotencyKeys = new Map<string, number>()

function buildHistoryKey(itemId: string): string {
  return `${itemId}#${Date.now()}#${Math.random().toString(36).slice(2, 10)}`
}

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

/**
 * Determines if an incoming item represents a clean fast-forward
 * (no concurrent edits detected)
 */
function isCleanFastForward(
  incomingItem: { branches?: VaultBranch[]; cipher?: string },
  currentItem?: { branches?: VaultBranch[]; cipher?: string },
): boolean {
  // Legacy items always fast-forward (cipher overwrite)
  if (incomingItem.cipher && !incomingItem.branches) {
    return true
  }

  // For branching format, ensure the incoming branch descends from the
  // current server branch head.
  if (incomingItem.branches && incomingItem.branches.length === 1) {
    const branch = incomingItem.branches[0]
    if (!currentItem) {
      return true
    }

    const currentHeadVersionId = currentItem.branches?.[0]?.versionId
    if (!currentHeadVersionId) {
      return true
    }

    return branch.parentIds.includes(currentHeadVersionId)
  }

  return false
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

  fetchItemHistory: protectedProcedure
    .input(FetchItemHistoryInputSchema)
    .query(async ({ ctx, input }) => {
      const history = await ctx.vault.fetchHistory(input.account, input.itemId, input.limit)
      return {
        success: true,
        history,
      }
    }),

  /**
   * putMany: Handles batch item updates with lineage-aware branch merging
   *
   * Condition 1: Clean Fast-Forward
   *   - Incoming parentIds includes current database versionId
   *   - Or item is legacy format (cipher overwrite)
   *   -> Use standard PutItem (overwrite)
   *
   * Condition 2: Concurrent Branch (Conflict)
   *   - Incoming parentIds does NOT include current versionId
   *   -> Use UpdateItem with list_append to branches array
   *
   * Condition 3: Real-Time Broadcast
   *   - Always broadcast resulting item via WebSocket
   */
  putMany: protectedProcedure
    .input(PutItemsBatchBodySchema)
    .mutation(async ({ ctx, input }) => {
      if (hasProcessedIdempotencyKey(input.idempotencyKey)) {
        return { success: true, conflicts: [] as string[] }
      }

      // First, fetch current versions from database to check lineage
      const currentItems = await ctx.vault.fetchMany({
        account: input.account,
        ids: input.items.map(item => item.id),
      }).catch(() => [])

      const currentVersionsById = new Map(
        currentItems.map(item => [item.item, item])
      )

      const expiresAt = Math.floor(Date.now() / 1000) + HISTORY_RETENTION_SECONDS
      const historyWrites = input.items
        .map(item => {
          const currentItem = currentVersionsById.get(item.id)
          if (!currentItem) {
            return null
          }

          return ctx.vault.putHistory({
            account: input.account,
            historyKey: buildHistoryKey(item.id),
            itemData: currentItem,
            expiresAt,
          })
        })
        .filter((promise): promise is Promise<void> => !!promise)

      if (historyWrites.length > 0) {
        await Promise.all(historyWrites)
      }

      const mappedItems = input.items.map(incomingItem => {
        const { deleted, id, modified, type, version } = incomingItem
        const _type = asItemType(type)
        const currentItem = currentVersionsById.get(id)

        // Determine if this is a fast-forward or a concurrent branch
        const fastForward = isCleanFastForward(incomingItem, currentItem)

        if (incomingItem.cipher) {
          // Legacy format: always overwrite
          return {
            account: input.account,
            item: id,
            cipher: incomingItem.cipher,
            metadata: {
              type: _type,
              iv: incomingItem.iv,
              modified,
              version,
              deleted,
            },
          }
        }

        if (incomingItem.branches) {
          // Branching format
          return {
            account: input.account,
            item: id,
            branches: incomingItem.branches,
            metadata: {
              type: _type,
              iv: incomingItem.iv,
              modified,
              version,
              deleted,
            },
            _fastForward: fastForward, // Metadata for driver to decide overwrite vs append
          }
        }

        // Fallback (should not happen with validated input)
        throw new Error(`Invalid item format for ${id}`)
      })

      try {
        await ctx.vault.setMany(mappedItems as Parameters<typeof ctx.vault.setMany>[0])
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

      const currentItem = await ctx.vault.fetchMany({
        account: input.account,
        ids: [input.item],
      }).then(items => items[0]).catch(() => undefined)

      if (currentItem) {
        await ctx.vault.putHistory({
          account: input.account,
          historyKey: buildHistoryKey(input.item),
          itemData: currentItem,
          expiresAt: Math.floor(Date.now() / 1000) + HISTORY_RETENTION_SECONDS,
        })
      }

      // Build item based on format (legacy cipher vs branches)
      const itemToSet: any = {
        account: input.account,
        item: input.item,
        metadata: {
          type: _type,
          modified: input.modified,
          version: input.version,
          deleted: input.deleted,
        },
      }

      if (input.cipher) {
        itemToSet.cipher = input.cipher
        itemToSet.metadata.iv = input.iv
      } else if ('branches' in input && input.branches) {
        itemToSet.branches = input.branches
      }

      try {
        await ctx.vault.set(itemToSet)
        await publishRealtimeEvent(input.account, 'items.updated', {
          itemIds: [input.item],
          count: 1,
        })
        markIdempotencyKeyProcessed(input.idempotencyKey)
        return { success: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message.includes('Version conflict')) {
          return {
            success: false,
            error: 'Version conflict' as const,
            conflicts: [input.item],
          }
        }
        throw error
      }
    }),

  /**
   * resolveBranchConflict: Replace multiple branches with a single merged branch
   * Called when a client detects multi-branch conflict and merges them using Automerge
   *
   * Process:
   * 1. Client fetches item with multiple branches
   * 2. Worker merges all branches deterministically
   * 3. Client encrypts merged result as new Automerge document
   * 4. Sends resolved branch to server via this endpoint
   * 5. Server replaces branches array with single branch
   * 6. Broadcast updated item to all clients
   */
  resolveBranchConflict: protectedProcedure
    .input(ResolveBatchConflictsSchema)
    .mutation(async ({ ctx, input }) => {
      if (hasProcessedIdempotencyKey(input.idempotencyKey)) {
        return { success: true, resolvedCount: input.resolutions.length }
      }

      const results: Array<{ item: string; success: boolean; error?: string }> = []

      const currentItems = await ctx.vault.fetchMany({
        account: input.account,
        ids: input.resolutions.map(resolution => resolution.item),
      }).catch(() => [])

      const currentById = new Map(currentItems.map(item => [item.item, item]))
      const expiresAt = Math.floor(Date.now() / 1000) + HISTORY_RETENTION_SECONDS

      // Process each resolution
      for (const resolution of input.resolutions) {
        try {
          const currentItem = currentById.get(resolution.item)
          if (currentItem) {
            await ctx.vault.putHistory({
              account: input.account,
              historyKey: buildHistoryKey(resolution.item),
              itemData: currentItem,
              expiresAt,
            })
          }

          await ctx.vault.resolveBranchConflict(
            input.account,
            resolution.item,
            resolution.resolvedBranch,
          )
          results.push({ item: resolution.item, success: true })
        } catch (error) {
          results.push({
            item: resolution.item,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      }

      // Broadcast resolved items
      const resolvedItemIds = results.filter(r => r.success).map(r => r.item)
      if (resolvedItemIds.length > 0) {
        await publishRealtimeEvent(input.account, 'items.updated', {
          itemIds: resolvedItemIds,
          count: resolvedItemIds.length,
        })
      }

      markIdempotencyKeyProcessed(input.idempotencyKey)

      // Return results
      const failedResolutions = results.filter(r => !r.success)
      if (failedResolutions.length > 0) {
        return {
          success: false,
          resolvedCount: results.filter(r => r.success).length,
          failed: failedResolutions,
        }
      }

      return { success: true, resolvedCount: results.length }
    }),
})