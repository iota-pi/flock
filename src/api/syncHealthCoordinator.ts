import * as Sentry from '@sentry/react'
import { subscribeRealtimeBusSyncPing } from '../sync/client/realtimeBus'
import type { ItemId } from '../shared/schemas/items'
import {
  readManualRecoveryCount,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from '../sync/shared/manualRecoveryStore'
import { normalizeSyncError } from '../shared/syncErrors'
import { useAppStore } from 'src/state/store'


let onRecoveryItemsChangedListener: (() => void) | null = null

export function setOnRecoveryItemsChangedListener(listener: () => void): void {
  onRecoveryItemsChangedListener = listener
}

type DecryptionFailedEvent = {
  itemId?: ItemId
  error: unknown
}

const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000
let unsubscribeRealtimeBus: (() => void) | null = null

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

export function resetSyncHealthState(): void {
  tracker.reset()
  teardownSyncHealthWatchers()
}


async function triggerManualRecoveryUI(accountId: string, itemId: ItemId, reason: string): Promise<void> {
  await upsertManualRecoveryEntry(accountId, { itemId, reason })
  onRecoveryItemsChangedListener?.()

  const count = await readManualRecoveryCount(accountId)

  if (count > 0) {
    Sentry.captureMessage('Manual recovery required for corrupted items', {
      level: 'warning',
      extra: {
        count,
      },
    })
  }
}

async function attemptAutoRecovery(accountId: string, itemId: ItemId, failedBranches?: string[]): Promise<void> {
  const now = Date.now()
  if (tracker.isInFlight(itemId) || tracker.getRecoveryCooldownUntil(itemId) > now) {
    return
  }

  tracker.setInFlight(itemId, true)

  try {
    const branchHint = failedBranches && failedBranches.length > 0
      ? `Corrupted branches: ${failedBranches.join(', ')}`
      : 'Automated recovery is unavailable for this revision'

    await triggerManualRecoveryUI(accountId, itemId, branchHint)
    tracker.setRecoveryCooldown(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
  } finally {
    tracker.setInFlight(itemId, false)
  }
}

export async function clearManualRecoveryForItems(accountId: string, itemIds: ItemId[]): Promise<void> {
  const uniqueItemIds = Array.from(new Set(itemIds.filter(itemId => !!itemId)))
  if (uniqueItemIds.length === 0) {
    return
  }

  const previousCount = await readManualRecoveryCount(accountId)
  if (previousCount === 0) {
    return
  }

  for (const itemId of uniqueItemIds) {
    await removeManualRecoveryEntryByItemId(accountId, itemId)
    tracker.clearRecoveryCooldown(itemId)
    tracker.setInFlight(itemId, false)
  }

  const nextCount = await readManualRecoveryCount(accountId)
  if (nextCount !== previousCount) {
    onRecoveryItemsChangedListener?.()
  }
}

export function initializeSyncHealthWatchers(): () => void {
  if (!unsubscribeRealtimeBus) {
    unsubscribeRealtimeBus = subscribeRealtimeBusSyncPing(itemIds => {
      if (itemIds && itemIds.length > 0) {
        const accountId = useAppStore.getState().account
        if (accountId) {
          clearManualRecoveryForItems(accountId, itemIds).catch(console.error)
        }
      }
    })
  }

  return () => {
    teardownSyncHealthWatchers()
  }
}

export function teardownSyncHealthWatchers(): void {
  if (unsubscribeRealtimeBus) {
    unsubscribeRealtimeBus()
    unsubscribeRealtimeBus = null
  }
}

export function reportDecryptionFailure(accountId: string, event: DecryptionFailedEvent): void {
  const normalizedError = normalizeSyncError(event.error)

  console.error('[Decryption] Failed to decrypt item', {
    itemId: event.itemId,
    error: normalizedError,
  })

  if (typeof event.itemId === 'string') {
    attemptAutoRecovery(accountId, event.itemId).catch(error => {
      console.error(`Failed to run auto-recovery after decryption failure for item ${event.itemId}`, error)
    })
  }
}