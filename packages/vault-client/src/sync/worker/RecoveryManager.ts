import type { ItemId } from '@vault/shared/ids'
import { ClientEventHub } from './SyncEventHub'
import {
  type ManualRecoveryEntry,
  type ManualRecoveryKind,
  type ReadManualRecoveryOptions,
  readManualRecoveryEntries,
  readManualRecoveryCount,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
  removeManualRecoveryEntryIfKind,
  upsertManualRecoveryEntry,
} from '../shared/manualRecoveryStore'
import { normalizeSyncError } from '@vault/shared/syncErrors'
import { SYNC_TIMEOUTS } from '../syncConfig'
import type { LifecycleAware } from './ServiceLifecycleManager'


// Quarantines that a fresh, successfully parsed remote message proves were transient
export const INBOUND_MESSAGE_RESOLVABLE_KINDS: ReadonlySet<ManualRecoveryKind> = new Set(['pullDecryption'])

export interface RecoveryManagerDeps {
  accountId?: string | null
  eventHub?: ClientEventHub
}

export interface QuarantineOptions {
  checkCooldown?: boolean
  cooldownMs?: number
  failedBranches?: string[]
}

export class RecoveryManager implements LifecycleAware {
  readonly lifecycleName = 'RecoveryManager'
  private accountId: string | null = null
  private eventHub?: ClientEventHub
  private inFlightItemIds = new Set<ItemId>()
  private cooldownUntilByItemId = new Map<ItemId, number>()

  onLifecycleStop(): void {
    this.resetRecoveryState()
  }

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

  async pushRecoveryItems(accountId?: string | null, options?: ReadManualRecoveryOptions): Promise<ManualRecoveryEntry[]> {
    const targetAccount = accountId !== undefined ? accountId : this.accountId
    if (!targetAccount) return []
    try {
      const entries = await readManualRecoveryEntries(targetAccount, options)
      this.eventHub?.emit({ type: 'recoveryItemsChanged', entries })
      return entries
    } catch (error) {
      console.error('[RecoveryManager] Failed to push recovery entries change', error)
      return []
    }
  }

  async listRecoveryItems(accountId?: string | null, options?: ReadManualRecoveryOptions): Promise<ManualRecoveryEntry[]> {
    const targetAccount = accountId !== undefined ? accountId : this.accountId
    if (!targetAccount) return []
    return await readManualRecoveryEntries(targetAccount, options)
  }

  async quarantine(
    itemId: ItemId,
    kind: ManualRecoveryKind,
    error?: unknown,
    options?: QuarantineOptions,
  ): Promise<void> {
    const accountId = this.accountId
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
      } else if (typeof error === 'string') {
        reason = error
      } else if (error) {
        const normalized = normalizeSyncError(error)
        reason = normalized.message || 'Automated recovery is unavailable for this revision'
      } else {
        reason = 'Automated recovery is unavailable for this revision'
      }

      await upsertManualRecoveryEntry(accountId, { itemId, reason, kind })
      await this.pushRecoveryItems(accountId)

      const cooldownMs = options?.cooldownMs ?? SYNC_TIMEOUTS.recoveryCooldown
      this.setRecoveryCooldown(itemId, Date.now() + cooldownMs)
    } catch (err) {
      console.error(`[RecoveryManager] Failed to quarantine item ${itemId}:`, err)
      throw err
    } finally {
      this.setInFlight(itemId, false)
    }
  }

  async unquarantine(itemId: ItemId): Promise<void> {
    const accountId = this.accountId
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

  async resolveQuarantines(itemIds: ItemId[], kinds: ReadonlySet<ManualRecoveryKind>): Promise<void> {
    const accountId = this.accountId
    if (!accountId) return
    const uniqueItemIds = Array.from(new Set(itemIds.filter(id => Boolean(id))))
    if (uniqueItemIds.length === 0) return

    if (await readManualRecoveryCount(accountId) === 0) return

    let removedAny = false
    for (const itemId of uniqueItemIds) {
      const removed = await removeManualRecoveryEntryIfKind(accountId, itemId, kinds)
      if (removed) {
        removedAny = true
        this.clearRecoveryCooldown(itemId)
        this.setInFlight(itemId, false)
      }
    }

    if (removedAny) {
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

  async attemptAutoRecovery(
    itemId: ItemId,
    kind: 'pullDecryption' | 'snapshotDecryption',
    failedBranches?: string[],
  ): Promise<void> {
    if (!this.accountId) return
    try {
      await this.quarantine(
        itemId,
        kind,
        null,
        { checkCooldown: true, failedBranches },
      )
    } catch (error) {
      console.error('[RecoveryManager] Failed to record manual recovery entry', error)
    }
  }

  async reportDecryptionFailure(
    itemId: ItemId,
    kind: 'pullDecryption' | 'snapshotDecryption',
    error: unknown,
    failedBranches?: string[],
  ): Promise<void> {
    const normalizedError = normalizeSyncError(error)
    console.error('[RecoveryManager] Failed to decrypt item', {
      itemId,
      error: normalizedError,
    })

    if (!itemId) return
    await this.attemptAutoRecovery(itemId, kind, failedBranches)
  }
}
