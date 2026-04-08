import * as Sentry from '@sentry/react'
import type { ItemId } from '../shared/itemTypes'
import {
  readManualRecoveryCount,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from '../sync/manualRecoveryStore'
import { normalizeSyncError } from '../shared/syncErrors'
import { configureDecryptionWorkerCallbacks } from '../workers/decryptionWorkerManager'
import { useToastStore } from '../state/toastStore'

export type DecryptionFailedEvent = {
  source: 'worker' | 'main-thread'
  itemId?: string
  error: unknown
}

const recoveryInFlightItemIds = new Set<ItemId>()
const recoveryCooldownUntilByItemId = new Map<ItemId, number>()
const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000
let syncHealthWatchersInitialized = false

function getRecoveryCooldownUntil(itemId: ItemId): number {
  return recoveryCooldownUntilByItemId.get(itemId) || 0
}

async function triggerManualRecoveryUI(itemId: ItemId, reason: string): Promise<void> {
  await upsertManualRecoveryEntry({ itemId, reason })

  const count = await readManualRecoveryCount()
  useToastStore.getState().setMessage({
    severity: 'warning',
    message: reason || 'A corrupted item was detected. Recovery will be attempted automatically.',
  })

  if (count > 0) {
    Sentry.captureMessage('Manual recovery required for corrupted items', {
      level: 'warning',
      extra: {
        count,
      },
    })
  }
}

async function attemptAutoRecovery(itemId: ItemId, failedBranches?: string[]): Promise<void> {
  const now = Date.now()
  if (recoveryInFlightItemIds.has(itemId) || getRecoveryCooldownUntil(itemId) > now) {
    return
  }

  recoveryInFlightItemIds.add(itemId)

  try {
    const branchHint = failedBranches && failedBranches.length > 0
      ? `Corrupted branches: ${failedBranches.join(', ')}`
      : 'Automated recovery is unavailable for this revision'

    await triggerManualRecoveryUI(itemId, branchHint)
    recoveryCooldownUntilByItemId.set(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
  } finally {
    recoveryInFlightItemIds.delete(itemId)
  }
}

export async function clearManualRecoveryForItems(itemIds: ItemId[]): Promise<void> {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(itemId => !!itemId)))
  if (uniqueItemIds.length === 0) {
    return
  }

  const previousCount = await readManualRecoveryCount()
  if (previousCount === 0) {
    return
  }

  for (const itemId of uniqueItemIds) {
    await removeManualRecoveryEntryByItemId(itemId)
  }

  const nextCount = await readManualRecoveryCount()
  if (nextCount !== previousCount) {
    useToastStore.getState().setMessage({
      severity: 'success',
      message: 'Recovered a corrupted item revision.',
    })
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
    onConflictResolved: ({ itemId }) => {
      console.info(`[Automerge] Local conflict resolved for ${itemId}; awaiting sync dispatcher push`)
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

  useToastStore.getState().setMessage({
    severity: 'warning',
    message: reason || 'A corrupted item was detected. Recovery will be attempted automatically.',
  })

  if (event.source === 'worker' && typeof event.itemId === 'string') {
    attemptAutoRecovery(event.itemId).catch(error => {
      console.error(`Failed to run auto-recovery after decryption failure for item ${event.itemId}`, error)
    })
  }
}