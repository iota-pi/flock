import type { ItemId } from '@vault/shared'
import type { ClientEventHub } from './SyncEventHub'
import {
  type ManualRecoveryDetail,
  type ManualRecoveryEntry,
  type ManualRecoveryKind,
  type ManualRecoveryMatch,
  type ReadManualRecoveryOptions,
  readManualRecoveryEntries,
  readManualRecoveryCount,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
  removeManualRecoveryEntryIfMatches,
  upsertManualRecoveryEntry,
} from '../shared/manualRecoveryStore'
import { normalizeSyncError } from '@vault/shared'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('RecoveryManager')

// Quarantines that a fresh, successfully parsed remote message proves were transient
export const INBOUND_MESSAGE_RESOLVABLE_KINDS: ReadonlySet<ManualRecoveryKind> = new Set(['pullDecryption'])

export interface RecoveryManagerDeps {
  accountId: string
  eventHub: ClientEventHub
}

export interface QuarantineOptions {
  checkCooldown?: boolean
  cooldownMs?: number
  /** The server version that failed, recorded so manifest sync waits for a newer one */
  serverVersion?: number
}

/**
 * Tracks in-flight quarantines and cooldowns by item and kind, so that a report of one kind never hides
 * another kind for the same item. The store serialises writes to an item and keeps the stronger kind.
 */
export class RecoveryManager {
  private inFlightKinds = new Map<ItemId, Set<ManualRecoveryKind>>()
  private cooldownUntilByItemId = new Map<ItemId, Map<ManualRecoveryKind, number>>()

  constructor(private readonly deps: RecoveryManagerDeps) {}

  private isInFlight(itemId: ItemId, kind?: ManualRecoveryKind): boolean {
    const kinds = this.inFlightKinds.get(itemId)
    if (!kinds) return false
    return kind ? kinds.has(kind) : kinds.size > 0
  }

  private setInFlight(itemId: ItemId, kind: ManualRecoveryKind, inFlight: boolean): void {
    const kinds = this.inFlightKinds.get(itemId) ?? new Set<ManualRecoveryKind>()
    if (inFlight) {
      kinds.add(kind)
      this.inFlightKinds.set(itemId, kinds)
    } else {
      kinds.delete(kind)
      if (kinds.size === 0) this.inFlightKinds.delete(itemId)
    }
  }

  private getRecoveryCooldownUntil(itemId: ItemId, kind: ManualRecoveryKind): number {
    const byKind = this.cooldownUntilByItemId.get(itemId)
    const cooldownUntil = byKind?.get(kind) || 0
    if (cooldownUntil <= Date.now()) {
      byKind?.delete(kind)
      if (byKind?.size === 0) this.cooldownUntilByItemId.delete(itemId)
      return 0
    }
    return cooldownUntil
  }

  private setRecoveryCooldown(itemId: ItemId, kind: ManualRecoveryKind, cooldownUntil: number): void {
    const byKind = this.cooldownUntilByItemId.get(itemId) ?? new Map<ManualRecoveryKind, number>()
    byKind.set(kind, cooldownUntil)
    this.cooldownUntilByItemId.set(itemId, byKind)
  }

  /** Forgets an item's cooldowns and in-flight quarantines of every kind */
  private clearRecoveryState(itemId: ItemId): void {
    this.cooldownUntilByItemId.delete(itemId)
    this.inFlightKinds.delete(itemId)
  }

  resetRecoveryState(): void {
    this.inFlightKinds.clear()
    this.cooldownUntilByItemId.clear()
  }

  async pushRecoveryItems(options?: ReadManualRecoveryOptions): Promise<ManualRecoveryEntry[]> {
    try {
      const entries = await readManualRecoveryEntries(this.deps.accountId, options)
      this.deps.eventHub.emit({ type: 'recoveryItemsChanged', entries })
      return entries
    } catch (error) {
      log.error('Failed to push recovery entries change', error)
      return []
    }
  }

  async listRecoveryItems(options?: ReadManualRecoveryOptions): Promise<ManualRecoveryEntry[]> {
    return await readManualRecoveryEntries(this.deps.accountId, options)
  }

  /**
   * Records an item for manual recovery. The detail is stored unsealed, so callers log the error itself
   * rather than passing its message on.
   */
  async quarantine(
    itemId: ItemId,
    kind: ManualRecoveryKind,
    detail: ManualRecoveryDetail,
    options?: QuarantineOptions,
  ): Promise<void> {
    const accountId = this.deps.accountId
    if (!itemId) return

    // A repeat of a kind already being recorded is dropped, but a different kind is recorded too
    if (this.isInFlight(itemId, kind)) return
    if (options?.checkCooldown && this.getRecoveryCooldownUntil(itemId, kind) > Date.now()) return

    this.setInFlight(itemId, kind, true)
    try {
      await upsertManualRecoveryEntry(accountId, { itemId, detail, kind, serverVersion: options?.serverVersion })
      await this.pushRecoveryItems()

      const cooldownMs = options?.cooldownMs ?? SYNC_TIMEOUTS.recoveryCooldown
      this.setRecoveryCooldown(itemId, kind, Date.now() + cooldownMs)
    } catch (err) {
      log.error(`Failed to quarantine item ${itemId}:`, err)
      throw err
    } finally {
      this.setInFlight(itemId, kind, false)
    }
  }

  async unquarantine(itemId: ItemId): Promise<void> {
    const accountId = this.deps.accountId
    if (!itemId) return

    try {
      await removeManualRecoveryEntryByItemId(accountId, itemId)
    } catch (error) {
      log.error(`Failed to remove manual recovery entry for item ${itemId}:`, error)
      throw error
    }

    this.clearRecoveryState(itemId)

    await this.pushRecoveryItems()
  }

  /** Clears the items' entries that `match` accepts, leaving any other entry for them in place */
  async resolveQuarantines(itemIds: ItemId[], match: ManualRecoveryMatch): Promise<void> {
    const accountId = this.deps.accountId
    const uniqueItemIds = Array.from(new Set(itemIds.filter(id => Boolean(id))))
    if (uniqueItemIds.length === 0) return

    if (await readManualRecoveryCount(accountId) === 0) return

    let removedAny = false
    for (const itemId of uniqueItemIds) {
      const removed = await removeManualRecoveryEntryIfMatches(accountId, itemId, match)
      if (removed) {
        removedAny = true
        this.clearRecoveryState(itemId)
      }
    }

    if (removedAny) {
      await this.pushRecoveryItems()
    }
  }

  async dismissEntry(entryId: string): Promise<void> {
    const accountId = this.deps.accountId
    if (!entryId) return

    await removeManualRecoveryEntryById(accountId, entryId)
    await this.pushRecoveryItems()
  }

  async reportDecryptionFailure(
    itemId: ItemId,
    kind: 'pullDecryption' | 'snapshotDecryption' | 'localDecryption',
    error: unknown,
    options?: Pick<QuarantineOptions, 'serverVersion'>,
  ): Promise<void> {
    const normalizedError = normalizeSyncError(error)
    log.error('Failed to decrypt item', {
      itemId,
      error: normalizedError,
    })

    if (!itemId) return
    try {
      await this.quarantine(itemId, kind, { code: 'decryptionFailed' }, { ...options, checkCooldown: true })
    } catch (quarantineError) {
      log.error('Failed to record manual recovery entry', quarantineError)
    }
  }
}
