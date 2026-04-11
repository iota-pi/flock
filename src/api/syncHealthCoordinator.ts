import * as Sentry from '@sentry/react'
import type { ItemId } from '../shared/itemTypes'
import {
  readManualRecoveryCount,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from '../sync/manualRecoveryStore'
import { normalizeSyncError } from '../shared/syncErrors'
import { useToastStore } from '../state/toastStore'

export type DecryptionFailedEvent = {
  source: 'worker' | 'main-thread'
  itemId?: string
  error: unknown
}

const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000
let syncHealthWatchersInitialized = false

class SyncHealthState {
  private inFlightItemIds = new Set<ItemId>()
  private cooldownUntilByItemId = new Map<ItemId, number>()
  private cooldownCleanupTimeoutByItemId = new Map<ItemId, ReturnType<typeof setTimeout>>()

  clearRecoveryCooldown(itemId: ItemId): void {
    const timeoutId = this.cooldownCleanupTimeoutByItemId.get(itemId)
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
      this.cooldownCleanupTimeoutByItemId.delete(itemId)
    }

    this.cooldownUntilByItemId.delete(itemId)
  }

  setRecoveryCooldown(itemId: ItemId, cooldownUntil: number): void {
    this.clearRecoveryCooldown(itemId)
    this.cooldownUntilByItemId.set(itemId, cooldownUntil)

    const delayMs = Math.max(0, cooldownUntil - Date.now())
    const timeoutId = setTimeout(() => {
      this.cooldownCleanupTimeoutByItemId.delete(itemId)
      this.cooldownUntilByItemId.delete(itemId)
    }, delayMs)

    this.cooldownCleanupTimeoutByItemId.set(itemId, timeoutId)
  }

  getRecoveryCooldownUntil(itemId: ItemId): number {
    const cooldownUntil = this.cooldownUntilByItemId.get(itemId) || 0
    if (cooldownUntil <= Date.now()) {
      this.clearRecoveryCooldown(itemId)
      return 0
    }

    return cooldownUntil
  }

  isInFlight(itemId: ItemId): boolean {
    return this.inFlightItemIds.has(itemId)
  }

  setInFlight(itemId: ItemId, value: boolean): void {
    if (value) {
      this.inFlightItemIds.add(itemId)
    } else {
      this.inFlightItemIds.delete(itemId)
    }
  }

  reset(): void {
    this.inFlightItemIds.clear()
    this.cooldownUntilByItemId.clear()
    for (const timeoutId of this.cooldownCleanupTimeoutByItemId.values()) {
      clearTimeout(timeoutId)
    }
    this.cooldownCleanupTimeoutByItemId.clear()
  }
}

const tracker = new SyncHealthState()

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
  if (tracker.isInFlight(itemId) || tracker.getRecoveryCooldownUntil(itemId) > now) {
    return
  }

  tracker.setInFlight(itemId, true)

  try {
    const branchHint = failedBranches && failedBranches.length > 0
      ? `Corrupted branches: ${failedBranches.join(', ')}`
      : 'Automated recovery is unavailable for this revision'

    await triggerManualRecoveryUI(itemId, branchHint)
    tracker.setRecoveryCooldown(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
  } finally {
    tracker.setInFlight(itemId, false)
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
    tracker.clearRecoveryCooldown(itemId)
    tracker.setInFlight(itemId, false)
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