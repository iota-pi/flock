import { TRPCError } from '@trpc/server'
import { asItemType } from '../drivers/base'
import type BaseDriver from '../drivers/base'
import type { VaultItem, VaultItemHistory } from '../drivers/base'
import { TransactionConflictsError } from '../drivers/dynamo'
import { publishRealtimeEvent } from '../realtime/hub'
import type { VaultBranch } from '../../shared/itemTypes'
import { isVersionConflictError } from '../../shared/syncErrors'

type ItemServiceContext = {
  vault: BaseDriver
}

const HISTORY_RETENTION_SECONDS = 30 * 24 * 60 * 60
const BRANCH_IV_PLACEHOLDER = 'branch'

function buildHistoryKey(itemId: string): string {
  return `${itemId}#${Date.now()}#${Math.random().toString(36).slice(2, 10)}`
}

function getMissingParentIds(incomingParentIds: string[], knownBranchIds: Set<string>): string[] {
  return incomingParentIds.filter(parentId => !knownBranchIds.has(parentId))
}

function makeHistoryEntry(account: string, itemId: string, itemData: VaultItem): VaultItemHistory {
  return {
    account,
    historyKey: buildHistoryKey(itemId),
    itemData,
    expiresAt: Math.floor(Date.now() / 1000) + HISTORY_RETENTION_SECONDS,
  }
}

export async function fetchItems(
  ctx: ItemServiceContext,
  input: { account: string; cacheTime?: number | null; ids?: string[] },
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
  input: { account: string; itemId: string; limit?: number },
): Promise<VaultItem[]> {
  return ctx.vault.fetchHistory(input.account, input.itemId, input.limit)
}

export async function putManyItems(
  ctx: ItemServiceContext,
  input: {
    account: string
    items: Array<{
      id: string
      modified: number
      type: string
      branches: VaultBranch[]
      deleted?: boolean
    }>
  },
): Promise<{ success: true; conflicts: string[] } | { success: false; error: 'Version conflict'; conflicts: string[] }> {
  const currentItems = await ctx.vault.fetchMany({
    account: input.account,
    ids: input.items.map(item => item.id),
  }).catch(() => [])

  const currentById = new Map(currentItems.map(item => [item.item, item]))

  const mappedItems = input.items.map(incomingItem => {
    const expectedParentVersionId = incomingItem.branches.length === 1
      ? incomingItem.branches[0].parentIds.at(-1)
      : undefined

    return {
      account: input.account,
      item: incomingItem.id,
      branches: incomingItem.branches,
      _expectedParentVersionId: expectedParentVersionId,
      metadata: {
        type: asItemType(incomingItem.type),
        iv: BRANCH_IV_PLACEHOLDER,
        modified: incomingItem.modified,
        deleted: incomingItem.deleted,
      },
    }
  })

  const historyEntries = input.items
    .map(item => {
      const currentItem = currentById.get(item.id)
      if (!currentItem) {
        return null
      }
      return makeHistoryEntry(input.account, item.id, currentItem)
    })
    .filter((entry): entry is VaultItemHistory => !!entry)

  try {
    await ctx.vault.archiveAndSetManyTransaction({
      historyEntries,
      replacements: mappedItems as VaultItem[],
    })

    await publishRealtimeEvent(input.account, 'items.updated', {
      itemIds: input.items.map(item => item.id),
      count: input.items.length,
    })

    return { success: true, conflicts: [] }
  } catch (error) {
    if (error instanceof TransactionConflictsError) {
      return {
        success: false,
        error: 'Version conflict',
        conflicts: error.conflictedIds,
      }
    }
    throw error
  }
}

export async function putItem(
  ctx: ItemServiceContext,
  input: {
    account: string
    item: string
    modified: number
    type: string
    branches: VaultBranch[]
    deleted?: boolean
  },
): Promise<{ success: true } | { success: false; error: 'Version conflict'; conflicts: string[] }> {
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

  const replacement: VaultItem & { _expectedParentVersionId?: string } = {
    account: input.account,
    item: input.item,
    branches: input.branches,
    _expectedParentVersionId: expectedParentVersionId,
    metadata: {
      type: asItemType(input.type),
      iv: BRANCH_IV_PLACEHOLDER,
      modified: input.modified,
      deleted: input.deleted,
    },
  }

  try {
    if (currentItem) {
      await ctx.vault.archiveAndReplaceTransaction({
        history: makeHistoryEntry(input.account, input.item, currentItem),
        replacement,
      })
    } else {
      await ctx.vault.set(replacement)
    }

    await publishRealtimeEvent(input.account, 'items.updated', {
      itemIds: [input.item],
      count: 1,
    })

    return { success: true }
  } catch (error) {
    if (isVersionConflictError(error)) {
      return {
        success: false,
        error: 'Version conflict',
        conflicts: [input.item],
      }
    }
    throw error
  }
}

export async function compactItem(
  ctx: ItemServiceContext,
  input: {
    account: string
    item: string
    baseVersionId: string
    compactedBranch: VaultBranch
  },
): Promise<{ success: true }> {
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

  const replacement: VaultItem & { _expectedParentVersionId?: string } = {
    account: input.account,
    item: input.item,
    branches: [input.compactedBranch],
    _expectedParentVersionId: currentItem.branches?.[0]?.versionId,
    metadata: {
      type: currentItem.metadata.type,
      iv: BRANCH_IV_PLACEHOLDER,
      modified: Date.now(),
      deleted: currentItem.metadata.deleted,
      compactedAt: Date.now(),
    },
  }

  try {
    await ctx.vault.archiveAndReplaceTransaction({
      history: makeHistoryEntry(input.account, input.item, currentItem),
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

  return { success: true }
}

export async function resolveBranchConflicts(
  ctx: ItemServiceContext,
  input: {
    account: string
    resolutions: Array<{ item: string; resolvedBranch: VaultBranch }>
  },
): Promise<
  | { success: true; resolvedCount: number }
  | {
    success: false
    resolvedCount: number
    failed: Array<{ item: string; success: false; error?: string }>
  }
> {
  const currentItems = await ctx.vault.fetchMany({
    account: input.account,
    ids: input.resolutions.map(resolution => resolution.item),
  }).catch(() => [])

  const currentById = new Map(currentItems.map(item => [item.item, item]))
  const results: Array<{ item: string; success: boolean; error?: string }> = []

  const resolutionResults = await Promise.all(input.resolutions.map(async resolution => {
    const currentItem = currentById.get(resolution.item)
    const replacement: VaultItem = {
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

    try {
      if (currentItem) {
        await ctx.vault.archiveAndReplaceTransaction({
          history: makeHistoryEntry(input.account, resolution.item, currentItem),
          replacement,
        })
      } else {
        await ctx.vault.set(replacement)
      }
      return { item: resolution.item, success: true } as const
    } catch (error) {
      return {
        item: resolution.item,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      } as const
    }
  }))

  results.push(...resolutionResults)

  const resolvedItemIds = results.filter(result => result.success).map(result => result.item)
  if (resolvedItemIds.length > 0) {
    await publishRealtimeEvent(input.account, 'items.updated', {
      itemIds: resolvedItemIds,
      count: resolvedItemIds.length,
    })
  }

  const failedResolutions = results.filter((result): result is { item: string; success: false; error?: string } => !result.success)
  if (failedResolutions.length > 0) {
    return {
      success: false,
      resolvedCount: results.filter(result => result.success).length,
      failed: failedResolutions,
    }
  }

  return {
    success: true,
    resolvedCount: results.length,
  }
}
