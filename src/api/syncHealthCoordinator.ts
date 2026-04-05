import type { ItemId } from '../shared/itemTypes'
import { trpcClient } from './trpcClient'
import { getAccountId } from './util'
import { hasApiAuthToken } from './runtime'
import { getVaultKey } from './vault'
import {
  getMutationId,
  readDeadLetterQueue,
  writeDeadLetterQueue,
} from '../sync/offlineQueueStore'
import { emitSyncEvent } from '../sync/syncEvents'
import { normalizeSyncError } from '../shared/syncErrors'
import {
  configureDecryptionWorkerCallbacks,
  evaluateHistoryInWorker,
} from '../workers/decryptionWorkerManager'
import { queryClient } from './queryClient'
import type { VaultItem } from './vault/client'
import { getQueryKey } from '@trpc/react-query'
import { trpc } from './trpc'

export type DecryptionFailedEvent = {
  source: 'worker' | 'main-thread'
  itemId?: string
  error: unknown
}

const recoveryInFlightItemIds = new Set<ItemId>()
const recoveryCooldownUntilByItemId = new Map<ItemId, number>()
const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000
const MANUAL_RECOVERY_MUTATION_TYPE = 'items.manualRecovery'
let syncHealthWatchersInitialized = false

type WorkerResolvedBranch = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

async function queueConflictResolutions(
  resolutionItems: Array<{ itemId: ItemId; branch: WorkerResolvedBranch }>,
): Promise<void> {
  if (resolutionItems.length === 0) {
    return
  }

  try {
    if (!hasApiAuthToken()) {
      console.info('[Automerge] Deferring conflict resolution - offline')
      return
    }

    const account = getAccountId()
    const resolutions = resolutionItems.map(({ itemId, branch }) => ({
      item: itemId,
      resolvedBranch: branch,
    }))

    console.info(`[Automerge] Pushing conflict resolutions for ${resolutions.length} items`)

    const response = await trpcClient.items.resolveBranchConflict.mutate({
      account,
      resolutions,
      idempotencyKey: `conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }) as {
      success?: boolean
      resolvedCount?: number
      failed?: unknown[]
    }

    if (response?.success) {
      console.info(`[Automerge] Resolved ${response.resolvedCount || 0} conflict(s)`)
    } else if (Array.isArray(response?.failed) && response.failed.length > 0) {
      console.warn(`[Automerge] Partially resolved - ${response.failed.length} failed:`, response.failed)
    }
  } catch (error) {
    console.error('[Automerge] Failed to push conflict resolution', error)
  }
}

function getRecoveryCooldownUntil(itemId: ItemId): number {
  return recoveryCooldownUntilByItemId.get(itemId) || 0
}

async function triggerManualRecoveryUI(itemId: ItemId, reason: string): Promise<void> {
  const deadLetterQueue = await readDeadLetterQueue()
  const existing = deadLetterQueue.find(item => (
    item.mutationType === MANUAL_RECOVERY_MUTATION_TYPE
    && typeof (item.payload as { itemId?: unknown })?.itemId === 'string'
    && (item.payload as { itemId: ItemId }).itemId === itemId
  ))

  if (!existing) {
    deadLetterQueue.push({
      id: getMutationId(),
      mutationType: MANUAL_RECOVERY_MUTATION_TYPE,
      payload: { itemId },
      endpoint: 'manual-recovery',
      queuedAt: Date.now(),
      failedAt: Date.now(),
      errorReason: reason,
      lastErrorStatus: 500,
    })
    await writeDeadLetterQueue(deadLetterQueue)
  }

  emitSyncEvent({
    type: 'queue:dlq-count-changed',
    count: deadLetterQueue.length,
  })
  emitSyncEvent({
    type: 'sync:item-corrupted',
    itemId,
    reason,
  })
}

async function evaluateHistory(itemId: ItemId, history: VaultItem[]): Promise<VaultItem | null> {
  if (history.length === 0) {
    return null
  }

  return evaluateHistoryInWorker({
    key: getVaultKey(),
    itemId,
    history,
  })
}

async function attemptAutoRecovery(itemId: ItemId, failedBranches?: string[]): Promise<void> {
  const now = Date.now()
  if (recoveryInFlightItemIds.has(itemId) || getRecoveryCooldownUntil(itemId) > now) {
    return
  }

  recoveryInFlightItemIds.add(itemId)

  try {
    if (!hasApiAuthToken()) {
      return
    }

    const account = getAccountId()
    const historyResponse = await trpcClient.items.fetchItemHistory.query({
      account,
      itemId,
    }) as { success: boolean; history: VaultItem[] }

    if (!historyResponse.success || !Array.isArray(historyResponse.history) || historyResponse.history.length === 0) {
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      await triggerManualRecoveryUI(itemId, 'No history available for automated recovery')
      return
    }

    const healthyEnvelope = await evaluateHistory(itemId, historyResponse.history)

    if (!healthyEnvelope) {
      console.error(`[Recovery] No healthy historical envelope found for item ${itemId}`, { failedBranches })
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      await triggerManualRecoveryUI(itemId, 'All historical revisions are corrupted')
      return
    }

    if (!healthyEnvelope.branches || healthyEnvelope.branches.length === 0) {
      recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
      await triggerManualRecoveryUI(itemId, 'Historical recovery revision is not in branch format')
      return
    }

    await trpcClient.items.put.mutate({
      account,
      item: healthyEnvelope.item,
      branches: healthyEnvelope.branches,
      modified: Date.now(),
      type: healthyEnvelope.metadata.type,
      deleted: healthyEnvelope.metadata.deleted,
      idempotencyKey: `recovery-${itemId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    })

    recoveryCooldownUntilByItemId.delete(itemId)
    await queryClient.invalidateQueries({ queryKey: getQueryKey(trpc.items.fetchMany) })
    emitSyncEvent({
      type: 'sync:item-recovered',
      itemId,
    })
    console.info(`[Recovery] Successfully rolled back item ${itemId}`)
  } catch (error) {
    console.error(`[Recovery] Auto-recovery failed for item ${itemId}`, error)
    recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
    await triggerManualRecoveryUI(itemId, 'Automated recovery attempt failed')
  } finally {
    recoveryInFlightItemIds.delete(itemId)
  }
}

export function initializeSyncHealthWatchers(): void {
  if (syncHealthWatchersInitialized) {
    return
  }

  configureDecryptionWorkerCallbacks({
    onCorruptedItem: ({ itemId, failedBranches }) => {
      attemptAutoRecovery(itemId, failedBranches).catch(error => {
        console.error(`Failed to run auto-recovery for item ${itemId}`, error)
      })
    },
    onConflictResolved: ({ itemId, resolvedBranch }) => {
      queueConflictResolutions([{ itemId, branch: resolvedBranch }]).catch(error => {
        console.error('Failed to queue conflict resolution', error)
      })
    },
  })

  syncHealthWatchersInitialized = true
}

export function reportDecryptionFailure(event: DecryptionFailedEvent): void {
  const normalizedError = normalizeSyncError(event.error)
  const reason = normalizedError.message || 'Failed to decrypt item'

  console.error('[Decryption] Failed to decrypt item', {
    source: event.source,
    itemId: event.itemId,
    error: normalizedError,
  })

  emitSyncEvent({
    type: 'sync:item-corrupted',
    itemId: event.itemId,
    reason,
  })

  if (event.source === 'worker' && typeof event.itemId === 'string') {
    attemptAutoRecovery(event.itemId).catch(error => {
      console.error(`Failed to run auto-recovery after decryption failure for item ${event.itemId}`, error)
    })
  }
}