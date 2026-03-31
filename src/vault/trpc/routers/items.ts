import { router, idempotentProtectedProcedure, protectedProcedure } from '../trpc'
import {
  CompactItemBodySchema,
  FetchItemHistoryInputSchema,
  FetchItemsInputSchema,
  PutItemBodySchema,
  PutItemsBatchBodySchema,
  ResolveBatchConflictsSchema,
} from '../schemas'
import {
  compactItem,
  fetchItemHistory,
  fetchItems,
  putItem,
  putManyItems,
  resolveBranchConflicts,
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

  fetchItemHistory: protectedProcedure
    .input(FetchItemHistoryInputSchema)
    .query(async ({ ctx, input }) => {
      const history = await fetchItemHistory(ctx, input)
      return {
        success: true,
        history,
      }
    }),

  /**
   * putMany writes each item with database-enforced lineage conditions.
   * Branch writes carry parentIds and are rejected on divergent heads,
   * while idempotency keys are claimed in DynamoDB to stay serverless-safe.
   */
  putMany: idempotentProtectedProcedure
    .input(PutItemsBatchBodySchema)
    .mutation(async ({ ctx, input }) => putManyItems(ctx, input)),

  put: idempotentProtectedProcedure
    .input(PutItemBodySchema)
    .mutation(async ({ ctx, input }) => putItem(ctx, input)),

  compactItem: idempotentProtectedProcedure
    .input(CompactItemBodySchema)
    .mutation(async ({ ctx, input }) => compactItem(ctx, input)),

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
  resolveBranchConflict: idempotentProtectedProcedure
    .input(ResolveBatchConflictsSchema)
    .mutation(async ({ ctx, input }) => resolveBranchConflicts(ctx, input)),
})
