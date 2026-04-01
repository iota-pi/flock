import { TRPCError } from '@trpc/server'
import { asItemType } from '../drivers/base'
import type BaseDriver from '../drivers/base'
import type { IdempotencyWriteContext, VaultItem, VaultItemHistory, VaultItemHistoryPage } from '../drivers/base'
import { TransactionConflictsError } from '../drivers/dynamo'
import { publishRealtimeEvent } from '../realtime/hub'
import type { ItemId, VaultBranch } from '../../shared/itemTypes'
import { isVersionConflictError } from '../../shared/syncErrors'

type ItemServiceContext = {
  vault: BaseDriver
}

const HISTORY_RETENTION_SECONDS = 30 * 24 * 60 * 60
const IDEMPOTENCY_RETENTION_SECONDS = 24 * 60 * 60
const BRANCH_IV_PLACEHOLDER = 'branch'
const VERSION_CONFLICT_MESSAGE_PREFIX = 'VERSION_CONFLICT'

function buildHistoryKey(itemId: ItemId): string {
  return `${itemId}#${Date.now()}#${Math.random().toString(36).slice(2, 10)}`
}

function getMissingParentIds(incomingParentIds: string[], knownBranchIds: Set<string>): string[] {
  return incomingParentIds.filter(parentId => !knownBranchIds.has(parentId))
}

function makeHistoryEntry(account: string, itemId: ItemId, itemData: VaultItem): VaultItemHistory {
  return {
    account,
    historyKey: buildHistoryKey(itemId),
    itemData,
    expiresAt: Math.floor(Date.now() / 1000) + HISTORY_RETENTION_SECONDS,
  }
}

function toVersionConflictMessage(conflicts: ItemId[]): string {
  return `${VERSION_CONFLICT_MESSAGE_PREFIX}:${conflicts.join(',')}`
}

function throwVersionConflict(conflicts: ItemId[]): never {
  throw new TRPCError({
    code: 'CONFLICT',
    message: toVersionConflictMessage(conflicts),
    cause: { conflicts },
  })
}

function prepareTransactionEntities(input: {
  account: string
  itemId: ItemId
  type: string
  modified: number
  branches: VaultBranch[]
  deleted?: boolean
  compactedAt?: number
  currentItem?: VaultItem
  expectedParentVersionId?: string
}): {
  replacement: VaultItem & { _expectedParentVersionId?: string }
  historyEntry?: VaultItemHistory
} {
  const replacement: VaultItem & { _expectedParentVersionId?: string } = {
    account: input.account,
    item: input.itemId,
    branches: input.branches,
    _expectedParentVersionId: input.expectedParentVersionId,
    metadata: {
      type: asItemType(input.type),
      iv: BRANCH_IV_PLACEHOLDER,
      modified: input.modified,
      deleted: input.deleted,
      compactedAt: input.compactedAt,
    },
  }

  return {
    replacement,
    historyEntry: input.currentItem
      ? makeHistoryEntry(input.account, input.itemId, input.currentItem)
      : undefined,
  }
}

export async function fetchItems(
  ctx: ItemServiceContext,
  input: { account: string; cacheTime?: number | null; ids?: ItemId[] },
): Promise<{ items: VaultItem[]; serverTime: number }> {
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
    items: finalItems as VaultItem[],
    serverTime: Date.now(),
  }
}

export async function fetchItemHistory(
  ctx: ItemServiceContext,
  input: { account: string; itemId: ItemId; limit?: number; cursor?: string },
): Promise<VaultItemHistoryPage> {
  return ctx.vault.fetchHistory(input.account, input.itemId, input.limit, input.cursor)
}

function toIdempotencyContext(account: string, idempotencyKey?: string): IdempotencyWriteContext | undefined {
  if (!idempotencyKey) {
    return undefined
  }

  return {
    account,
    idempotencyKey,
    expiresAt: Math.floor(Date.now() / 1000) + IDEMPOTENCY_RETENTION_SECONDS,
  }
}

export async function putManyItems(
  ctx: ItemServiceContext,
  input: {
    account: string
    idempotencyKey?: string
    items: Array<{
      id: ItemId
      modified: number
      type: string
      branches: VaultBranch[]
      deleted?: boolean
    }>
  },
): Promise<void> {
  const currentItems = await ctx.vault.fetchMany({
    account: input.account,
    ids: input.items.map(item => item.id),
  }).catch(() => [])

  const currentById = new Map(currentItems.map(item => [item.item, item]))

  const entities = input.items.map(incomingItem => {
    const expectedParentVersionId = incomingItem.branches.length === 1
      ? incomingItem.branches[0].parentIds.at(-1)
      : undefined
    const currentItem = currentById.get(incomingItem.id)

    return prepareTransactionEntities({
      account: input.account,
      itemId: incomingItem.id,
      branches: incomingItem.branches,
      type: incomingItem.type,
      modified: incomingItem.modified,
      deleted: incomingItem.deleted,
      currentItem,
      expectedParentVersionId,
    })
  })

  const historyEntries = entities
    .map(entity => entity.historyEntry)
    .filter((entry): entry is VaultItemHistory => !!entry)

  const replacements = entities.map(entity => entity.replacement)

  try {
    await ctx.vault.archiveAndSetManyTransaction({
      historyEntries,
      replacements,
      idempotency: toIdempotencyContext(input.account, input.idempotencyKey),
    })

    await publishRealtimeEvent(input.account, 'items.updated', {
      itemIds: input.items.map(item => item.id),
      count: input.items.length,
    })

    return
  } catch (error) {
    if (error instanceof TransactionConflictsError) {
      throwVersionConflict(error.conflictedIds)
    }
    throw error
  }
}

export async function putItem(
  ctx: ItemServiceContext,
  input: {
    account: string
    item: ItemId
    modified: number
    type: string
    branches: VaultBranch[]
    deleted?: boolean
    idempotencyKey?: string
  },
): Promise<void> {
  const currentItem = await ctx.vault.fetchMany({
    account: input.account,
    ids: [input.item],
  }).then(items => items[0]).catch(() => undefined)

  const incomingParentIds = input.branches.length === 1
    ? input.branches[0].parentIds
    : []

  if (currentItem && incomingParentIds.length > 0) {
    const knownBranchIds = new Set((currentItem.branches || []).map(branch => branch.versionId))
    const missingParentIds = getMissingParentIds(incomingParentIds, knownBranchIds)
    if (missingParentIds.length > 0 && typeof currentItem.metadata?.compactedAt === 'number') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'STALE_COMPACTED_BRANCH',
        cause: {
          itemId: input.item,
          compactedAt: currentItem.metadata.compactedAt,
          missingParentIds,
        },
      })
    }
  }

  const expectedParentVersionId = input.branches.length === 1
    ? input.branches[0].parentIds.at(-1)
    : undefined

  const { replacement, historyEntry } = prepareTransactionEntities({
    account: input.account,
    itemId: input.item,
    branches: input.branches,
    type: input.type,
    modified: input.modified,
    deleted: input.deleted,
    currentItem,
    expectedParentVersionId,
  })

  try {
    if (currentItem) {
      await ctx.vault.archiveAndReplaceTransaction({
        history: historyEntry as VaultItemHistory,
        replacement,
        idempotency: toIdempotencyContext(input.account, input.idempotencyKey),
      })
    } else {
      await ctx.vault.archiveAndSetManyTransaction({
        historyEntries: [],
        replacements: [replacement],
        idempotency: toIdempotencyContext(input.account, input.idempotencyKey),
      })
    }

    await publishRealtimeEvent(input.account, 'items.updated', {
      itemIds: [input.item],
      count: 1,
    })

    return
  } catch (error) {
    if (isVersionConflictError(error)) {
      throwVersionConflict([input.item])
    }
    throw error
  }
}

export async function compactItem(
  ctx: ItemServiceContext,
  input: {
    account: string
    item: ItemId
    baseVersionId: ItemId
    compactedBranch: VaultBranch
  },
): Promise<void> {
  const currentItem = await ctx.vault.fetchMany({
    account: input.account,
    ids: [input.item],
  }).then(items => items[0]).catch(() => undefined)

  if (!currentItem) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: `Item not found: ${input.item}`,
    })
  }

  const knownVersionIds = new Set((currentItem.branches || []).map(branch => branch.versionId))
  if (!knownVersionIds.has(input.baseVersionId)) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'STALE_COMPACTED_BRANCH',
      cause: {
        itemId: input.item,
        baseVersionId: input.baseVersionId,
      },
    })
  }

  const { replacement, historyEntry } = prepareTransactionEntities({
    account: input.account,
    itemId: input.item,
    branches: [input.compactedBranch],
    type: currentItem.metadata.type,
    modified: Date.now(),
    deleted: currentItem.metadata.deleted,
    compactedAt: Date.now(),
    currentItem,
    expectedParentVersionId: currentItem.branches?.[0]?.versionId,
  })

  try {
    await ctx.vault.archiveAndReplaceTransaction({
      history: historyEntry as VaultItemHistory,
      replacement,
    })
  } catch (error) {
    if (isVersionConflictError(error)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'STALE_COMPACTED_BRANCH',
        cause: {
          itemId: input.item,
          baseVersionId: input.baseVersionId,
        },
      })
    }
    throw error
  }

  await publishRealtimeEvent(input.account, 'items.updated', {
    itemIds: [input.item],
    count: 1,
  })

  return
}

export async function resolveBranchConflicts(
  ctx: ItemServiceContext,
  input: {
    account: string
    idempotencyKey?: string
    resolutions: Array<{ item: ItemId; resolvedBranch: VaultBranch }>
  },
): Promise<
  | { success: true; resolvedCount: number }
  | {
    success: false
    resolvedCount: number
    failed: Array<{ item: ItemId; success: false; error?: string }>
  }
> {
  const currentItems = await ctx.vault.fetchMany({
    account: input.account,
    ids: input.resolutions.map(resolution => resolution.item),
  }).catch(() => [])

  const currentById = new Map(currentItems.map(item => [item.item, item]))
  const replacements = input.resolutions.map(resolution => {
    const currentItem = currentById.get(resolution.item)
    return {
      account: input.account,
      item: resolution.item,
      branches: [resolution.resolvedBranch],
      metadata: {
        type: currentItem?.metadata.type || 'person',
        iv: BRANCH_IV_PLACEHOLDER,
        modified: Date.now(),
        deleted: currentItem?.metadata.deleted,
        compactedAt: currentItem?.metadata.compactedAt,
      },
    }
  })

  const historyEntries = input.resolutions
    .map(resolution => {
      const currentItem = currentById.get(resolution.item)
      if (!currentItem) {
        return null
      }
      return makeHistoryEntry(input.account, resolution.item, currentItem)
    })
    .filter((entry): entry is VaultItemHistory => !!entry)

  try {
    await ctx.vault.archiveAndSetManyTransaction({
      historyEntries,
      replacements,
      idempotency: toIdempotencyContext(input.account, input.idempotencyKey),
    })
  } catch (error) {
    if (error instanceof TransactionConflictsError) {
      const conflictedSet = new Set(error.conflictedIds)
      const failed = input.resolutions
        .filter(resolution => conflictedSet.has(resolution.item))
        .map(resolution => ({
          item: resolution.item,
          success: false as const,
          error: 'Version conflict',
        }))

      if (failed.length > 0) {
        return {
          success: false,
          resolvedCount: Math.max(0, input.resolutions.length - failed.length),
          failed,
        }
      }
    }
    throw error
  }

  const resolvedItemIds = input.resolutions.map(result => result.item)
  if (resolvedItemIds.length > 0) {
    await publishRealtimeEvent(input.account, 'items.updated', {
      itemIds: resolvedItemIds,
      count: resolvedItemIds.length,
    })
  }

  return {
    success: true,
    resolvedCount: input.resolutions.length,
  }
}
