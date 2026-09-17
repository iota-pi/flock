import type { ItemId } from 'src/shared/schemas/items'
import { ClientEventHub } from './SyncEventHub'
import {
  type ManualRecoveryEntry,
  readManualRecoveryEntries,
  readManualRecoveryCount,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from '../shared/manualRecoveryStore'
import { normalizeSyncError } from 'src/shared/syncErrors'

export const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000

export interface RecoveryManagerDeps {
  accountId?: string | null
  eventHub?: ClientEventHub
}

export interface QuarantineOptions {
  checkCooldown?: boolean
  cooldownMs?: number
  failedBranches?: string[]
}

export class RecoveryManager {
  private accountId: string | null = null
  private eventHub?: ClientEventHub
  private inFlightItemIds = new Set<ItemId>()
  private cooldownUntilByItemId = new Map<ItemId, number>()

  constructor(deps?: RecoveryManagerDeps) {
    this.accountId = deps?.accountId ?? null
    this.eventHub = deps?.eventHub
  }

  setAccountId(accountId: string | null): void {
    this.accountId = accountId
  }

  getAccountId(): string | null {
    return this.accountId
  }

  setEventHub(eventHub?: ClientEventHub): void {
    this.eventHub = eventHub
  }

  isInFlight(itemId: ItemId): boolean {
    return this.inFlightItemIds.has(itemId)
  }

  setInFlight(itemId: ItemId, inFlight: boolean): void {
    if (inFlight) {
      this.inFlightItemIds.add(itemId)
    } else {
      this.inFlightItemIds.delete(itemId)
    }
  }

  getRecoveryCooldownUntil(itemId: ItemId): number {
    const cooldownUntil = this.cooldownUntilByItemId.get(itemId) || 0
    if (cooldownUntil <= Date.now()) {
      this.cooldownUntilByItemId.delete(itemId)
      return 0
    }
    return cooldownUntil
  }

  setRecoveryCooldown(itemId: ItemId, cooldownUntil: number): void {
    this.cooldownUntilByItemId.set(itemId, cooldownUntil)
  }

  clearRecoveryCooldown(itemId: ItemId): void {
    this.cooldownUntilByItemId.delete(itemId)
  }

  resetRecoveryState(): void {
    this.inFlightItemIds.clear()
    this.cooldownUntilByItemId.clear()
  }

  reset(): void {
    this.resetRecoveryState()
  }

  async pushRecoveryItems(accountId?: string | null): Promise<ManualRecoveryEntry[]> {
    const targetAccount = accountId !== undefined ? accountId : this.accountId
    if (!targetAccount) return []
    try {
      const entries = await readManualRecoveryEntries(targetAccount)
      this.eventHub?.emit({ type: 'recoveryItemsChanged', entries })
      return entries
    } catch (error) {
      console.error('[RecoveryManager] Failed to push recovery entries change', error)
      return []
    }
  }

  async listRecoveryItems(accountId?: string | null): Promise<ManualRecoveryEntry[]> {
    const targetAccount = accountId !== undefined ? accountId : this.accountId
    if (!targetAccount) return []
    return await readManualRecoveryEntries(targetAccount)
  }

  async quarantine(
    accountIdOrItemId: string | null,
    itemIdOrError?: ItemId | unknown,
    maybeErrorOrOptions?: unknown | QuarantineOptions,
    maybeOptions?: QuarantineOptions,
  ): Promise<void> {
    let accountId: string | null
    let itemId: ItemId
    let errorOrReason: unknown
    let options: QuarantineOptions | undefined

    if (
      typeof itemIdOrError === 'string' &&
      (typeof maybeErrorOrOptions !== 'undefined' || typeof maybeOptions !== 'undefined')
    ) {
      // Called as: quarantine(accountId, itemId, errorOrReason, options)
      accountId = accountIdOrItemId
      itemId = itemIdOrError as ItemId
      errorOrReason = maybeErrorOrOptions
      options = maybeOptions
    } else {
      // Called as: quarantine(itemId, errorOrReason, options)
      accountId = this.accountId
      itemId = accountIdOrItemId as ItemId
      errorOrReason = itemIdOrError
      options = maybeErrorOrOptions as QuarantineOptions | undefined
    }

    if (!accountId || !itemId) return

    const now = Date.now()
    if (options?.checkCooldown) {
      if (this.isInFlight(itemId) || this.getRecoveryCooldownUntil(itemId) > now) {
        return
      }
    } else if (this.isInFlight(itemId)) {
      return
    }

    this.setInFlight(itemId, true)
    try {
      let reason: string
      if (options?.failedBranches && options.failedBranches.length > 0) {
        reason = `Corrupted branches: ${options.failedBranches.join(', ')}`
      } else if (typeof errorOrReason === 'string') {
        reason = errorOrReason
      } else if (errorOrReason) {
        const normalized = normalizeSyncError(errorOrReason)
        reason = normalized.message || 'Automated recovery is unavailable for this revision'
      } else {
        reason = 'Automated recovery is unavailable for this revision'
      }

      await upsertManualRecoveryEntry(accountId, { itemId, reason })
      await this.pushRecoveryItems(accountId)

      const cooldownMs = options?.cooldownMs ?? RECOVERY_RETRY_COOLDOWN_MS
      this.setRecoveryCooldown(itemId, Date.now() + cooldownMs)
    } catch (error) {
      console.error(`[RecoveryManager] Failed to quarantine item ${itemId}:`, error)
      throw error
    } finally {
      this.setInFlight(itemId, false)
    }
  }

  async unquarantine(accountIdOrItemId: string | null, maybeItemId?: ItemId): Promise<void> {
    let accountId: string | null
    let itemId: ItemId

    if (maybeItemId !== undefined) {
      accountId = accountIdOrItemId
      itemId = maybeItemId
    } else {
      accountId = this.accountId
      itemId = accountIdOrItemId as ItemId
    }

    if (!accountId || !itemId) return

    try {
      await removeManualRecoveryEntryByItemId(accountId, itemId)
    } catch (error) {
      console.error(`[RecoveryManager] Failed to remove manual recovery entry for item ${itemId}:`, error)
      throw error
    }

    this.clearRecoveryCooldown(itemId)
    this.setInFlight(itemId, false)

    await this.pushRecoveryItems(accountId)
  }

  async unquarantineBatch(accountIdOrItemIds: string | null | ItemId[], maybeItemIds?: ItemId[]): Promise<void> {
    let accountId: string | null
    let itemIds: ItemId[]

    if (Array.isArray(accountIdOrItemIds)) {
      accountId = this.accountId
      itemIds = accountIdOrItemIds
    } else {
      accountId = accountIdOrItemIds
      itemIds = maybeItemIds ?? []
    }

    if (!accountId) return
    const uniqueItemIds = Array.from(new Set(itemIds.filter(id => Boolean(id))))
    if (uniqueItemIds.length === 0) return

    const previousCount = await readManualRecoveryCount(accountId)
    if (previousCount === 0) {
      for (const itemId of uniqueItemIds) {
        this.clearRecoveryCooldown(itemId)
        this.setInFlight(itemId, false)
      }
      return
    }

    for (const itemId of uniqueItemIds) {
      await removeManualRecoveryEntryByItemId(accountId, itemId)
      this.clearRecoveryCooldown(itemId)
      this.setInFlight(itemId, false)
    }

    const nextCount = await readManualRecoveryCount(accountId)
    if (nextCount !== previousCount) {
      await this.pushRecoveryItems(accountId)
    }
  }

  async dismissEntry(accountIdOrEntryId: string | null, maybeEntryId?: string): Promise<void> {
    let accountId: string | null
    let entryId: string

    if (maybeEntryId !== undefined) {
      accountId = accountIdOrEntryId
      entryId = maybeEntryId
    } else {
      accountId = this.accountId
      entryId = accountIdOrEntryId as string
    }

    if (!accountId || !entryId) return

    await removeManualRecoveryEntryById(accountId, entryId)
    await this.pushRecoveryItems(accountId)
  }

  async attemptAutoRecovery(itemId: ItemId, failedBranches?: string[]): Promise<void> {
    if (!this.accountId) return
    try {
      await this.quarantine(
        this.accountId,
        itemId,
        null,
        { checkCooldown: true, failedBranches },
      )
    } catch (error) {
      console.error('[RecoveryManager] Failed to record manual recovery entry', error)
    }
  }

  async reportDecryptionFailure(itemId: ItemId, error: unknown, failedBranches?: string[]): Promise<void> {
    const normalizedError = normalizeSyncError(error)
    console.error('[RecoveryManager] Failed to decrypt item', {
      itemId,
      error: normalizedError,
    })

    if (!itemId) return
    await this.attemptAutoRecovery(itemId, failedBranches)
  }
}
