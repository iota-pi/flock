import type { Item } from '../state/items'
import type { ItemId } from '../shared/itemTypes'
import type { QueuedMutation } from './offlineQueueStore'
import { fetchMany } from '../api/vault/client'
import { getVaultKey } from '../api/vault'
import {
  resolveQueueConflictInWorker as resolveQueueConflictWithManager,
  rescueStaleCompactedBranchInWorker as rescueStaleCompactedBranchWithManager,
} from '../workers/decryptionWorkerManager'

export const CONFLICT_HANDLER_AUTOMERGE_ITEMS = 'automerge-items'

type ResolvedBranch = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

export type QueueConflictHandler = {
  resolveVersionConflict?: (mutation: QueuedMutation) => Promise<QueuedMutation | null>
  resolveStaleCompactedBranch?: (mutation: QueuedMutation) => Promise<QueuedMutation | null>
}

async function mergeConflictBranchesInWorker(
  itemId: ItemId,
  localBranches: ResolvedBranch[],
  serverBranches: ResolvedBranch[],
): Promise<ResolvedBranch> {
  return resolveQueueConflictWithManager({
    key: getVaultKey(),
    itemId,
    localBranches,
    serverBranches,
  })
}

async function rescueStaleCompactedBranchInWorker(
  itemId: ItemId,
  localBranch: ResolvedBranch,
  serverBranch: ResolvedBranch,
): Promise<ResolvedBranch> {
  return rescueStaleCompactedBranchWithManager({
    key: getVaultKey(),
    itemId,
    localBranch,
    serverBranch,
  })
}

async function rescueQueuedStaleCompactedBranch(mutation: QueuedMutation): Promise<QueuedMutation | null> {
  if (mutation.mutationType !== 'items.put') {
    return null
  }

  const payload = mutation.payload as {
    account?: string
    item?: ItemId
    branches?: Array<ResolvedBranch>
    modified?: number
    type?: Item['type']
    deleted?: boolean
  }

  if (!payload.account || !payload.item || !Array.isArray(payload.branches) || payload.branches.length !== 1) {
    return null
  }

  const serverResult = await fetchMany({ ids: [payload.item] })
  const serverEnvelope = serverResult.items.find(item => item.item === payload.item)
  const serverBranch = serverEnvelope?.branches?.[0]

  if (!serverBranch) {
    return null
  }

  const rescuedBranch = await rescueStaleCompactedBranchInWorker(
    payload.item,
    payload.branches[0],
    serverBranch as ResolvedBranch,
  )

  return {
    ...mutation,
    payload: {
      ...payload,
      branches: [rescuedBranch],
      modified: Date.now(),
    },
    conflict: true,
    lastConflictAt: Date.now(),
    attemptCount: (mutation.attemptCount || 0) + 1,
    nextAttemptAt: Date.now() + 500,
  }
}

async function resolveQueuedPutConflict(mutation: QueuedMutation): Promise<QueuedMutation | null> {
  if (mutation.mutationType !== 'items.put' && mutation.mutationType !== 'items.putMany') {
    return null
  }

  if (mutation.mutationType === 'items.put') {
    const payload = mutation.payload as {
      account?: string
      item?: ItemId
      branches?: Array<ResolvedBranch>
      modified?: number
      type?: Item['type']
      deleted?: boolean
    }

    if (!payload.item || !Array.isArray(payload.branches) || payload.branches.length === 0) {
      return null
    }

    const serverResult = await fetchMany({ ids: [payload.item] })
    const serverEnvelope = serverResult.items.find(item => item.item === payload.item)
    if (!serverEnvelope?.branches || serverEnvelope.branches.length === 0) {
      return null
    }

    const resolvedBranch = await mergeConflictBranchesInWorker(
      payload.item,
      payload.branches,
      serverEnvelope.branches,
    )

    return {
      ...mutation,
      mutationType: 'items.resolveBranchConflict',
      payload: {
        account: payload.account,
        resolutions: [
          {
            item: payload.item,
            resolvedBranch,
          },
        ],
      },
      conflict: true,
      lastConflictAt: Date.now(),
      attemptCount: (mutation.attemptCount || 0) + 1,
      nextAttemptAt: Date.now() + 500,
    }
  }

  const batchPayload = mutation.payload as {
    account?: string
    items?: Array<{
      id?: ItemId
      branches?: Array<ResolvedBranch>
      type?: Item['type']
      deleted?: boolean
    }>
  }

  if (!batchPayload.account || !Array.isArray(batchPayload.items) || batchPayload.items.length === 0) {
    return null
  }

  const itemIds = batchPayload.items
    .map(item => item.id)
    .filter((id): id is ItemId => typeof id === 'string')
  if (itemIds.length === 0) {
    return null
  }

  const serverResult = await fetchMany({ ids: itemIds })
  const serverById = new Map(serverResult.items.map(item => [item.item, item]))

  const divergent = batchPayload.items.filter(item => {
    if (!item.id || !Array.isArray(item.branches) || item.branches.length === 0) {
      return false
    }
    const serverEnvelope = serverById.get(item.id)
    const serverHead = serverEnvelope?.branches?.[0]?.versionId
    if (!serverEnvelope?.branches || serverEnvelope.branches.length === 0) {
      return false
    }

    if (!serverHead) {
      return true
    }

    if (serverEnvelope.branches.length > 1) {
      return true
    }

    return !item.branches[0].parentIds.includes(serverHead)
  })

  if (divergent.length === 0) {
    return null
  }

  const resolutions = await Promise.all(divergent.map(async item => {
    const serverBranches = serverById.get(item.id as ItemId)?.branches || []
    const resolvedBranch = await mergeConflictBranchesInWorker(
      item.id as ItemId,
      item.branches as ResolvedBranch[],
      serverBranches as ResolvedBranch[],
    )

    return {
      item: item.id as ItemId,
      resolvedBranch,
    }
  }))

  return {
    ...mutation,
    mutationType: 'items.resolveBranchConflict',
    payload: {
      account: batchPayload.account,
      resolutions,
    },
    conflict: true,
    lastConflictAt: Date.now(),
    attemptCount: (mutation.attemptCount || 0) + 1,
    nextAttemptAt: Date.now() + 500,
  }
}

export function getConflictStrategiesByKey(): Record<string, QueueConflictHandler> {
  return {
    [CONFLICT_HANDLER_AUTOMERGE_ITEMS]: {
      resolveVersionConflict: resolveQueuedPutConflict,
      resolveStaleCompactedBranch: rescueQueuedStaleCompactedBranch,
    },
  }
}
