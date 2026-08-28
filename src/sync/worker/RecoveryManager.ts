import { ClientEventHub } from './SyncEventHub'
import {
  type ManualRecoveryEntry,
  readManualRecoveryEntries,
  readManualRecoveryCount,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from '../shared/manualRecoveryStore'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { mutateDraftToMatchSnapshot } from './utils/snapshot'
import type { ItemId } from 'src/shared/schemas/items'
import { normalizeSyncError } from 'src/shared/syncErrors'

export const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000

export class RecoveryManager {
  private inFlightItemIds = new Set<ItemId>()
  private cooldownUntilByItemId = new Map<ItemId, number>()

  constructor(
    private deps: {
      accountId: string
      docStore: AutomergeDocStore
      indexManager: AutomergeIndexManager
    },
    private eventHub: ClientEventHub
  ) {}

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

  reset(): void {
    this.inFlightItemIds.clear()
    this.cooldownUntilByItemId.clear()
  }

  async pushRecoveryItems(): Promise<void> {
    if (!this.deps.accountId) return
    try {
      const entries = await readManualRecoveryEntries(this.deps.accountId)
      this.eventHub.emit({ type: 'recoveryItemsChanged', entries })
    } catch (error) {
      console.error('[RecoveryManager] Failed to push recovery entries change', error)
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

  async attemptAutoRecovery(itemId: ItemId, failedBranches?: string[]): Promise<void> {
    if (!this.deps.accountId) return

    const now = Date.now()
    if (this.isInFlight(itemId) || this.getRecoveryCooldownUntil(itemId) > now) {
      return
    }

    this.setInFlight(itemId, true)
    try {
      const branchHint = failedBranches && failedBranches.length > 0
        ? `Corrupted branches: ${failedBranches.join(', ')}`
        : 'Automated recovery is unavailable for this revision'

      await upsertManualRecoveryEntry(this.deps.accountId, { itemId, reason: branchHint })
      await this.pushRecoveryItems()
      this.setRecoveryCooldown(itemId, Date.now() + RECOVERY_RETRY_COOLDOWN_MS)
    } catch (error) {
      console.error('[RecoveryManager] Failed to record manual recovery entry', error)
    } finally {
      this.setInFlight(itemId, false)
    }
  }

  async clearManualRecoveryForItems(itemIds: ItemId[]): Promise<void> {
    if (!this.deps.accountId) return
    const uniqueItemIds = Array.from(new Set(itemIds.filter(id => !!id)))
    if (uniqueItemIds.length === 0) return

    const previousCount = await readManualRecoveryCount(this.deps.accountId)
    if (previousCount === 0) {
      for (const itemId of uniqueItemIds) {
        this.clearRecoveryCooldown(itemId)
        this.setInFlight(itemId, false)
      }
      return
    }

    for (const itemId of uniqueItemIds) {
      await removeManualRecoveryEntryByItemId(this.deps.accountId, itemId)
      this.clearRecoveryCooldown(itemId)
      this.setInFlight(itemId, false)
    }

    const nextCount = await readManualRecoveryCount(this.deps.accountId)
    if (nextCount !== previousCount) {
      await this.pushRecoveryItems()
    }
  }

  async retryRecoveryItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    this.clearRecoveryCooldown(itemId)
    this.setInFlight(itemId, false)
    await removeManualRecoveryEntryByItemId(this.deps.accountId, itemId)
    await this.pushRecoveryItems()
  }

  async forceOverwriteRecoveryItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    const localItem = await this.deps.docStore.getAutomergeItem(itemId)
    if (!localItem) {
      throw new Error(`No local item found for ${itemId}. Force delete is available instead.`)
    }

    const localSnapshot = JSON.parse(JSON.stringify(localItem)) as Record<string, unknown>
    if (Array.isArray(localItem.prayedFor)) {
      localSnapshot.prayedFor = [...localItem.prayedFor]
    }

    await removeManualRecoveryEntryByItemId(this.deps.accountId, itemId)
    this.clearRecoveryCooldown(itemId)
    this.setInFlight(itemId, false)

    await this.deps.docStore.changeDocument(
      itemId,
      doc => {
        mutateDraftToMatchSnapshot(doc, localSnapshot)
        if (typeof doc.id !== 'string' || doc.id.length === 0) {
          doc.id = itemId
        }
      },
      { createIfMissing: true },
    )

    await this.deps.indexManager.addAutomergeItemIdsToIndex([itemId])
    await this.pushRecoveryItems()
  }

  async forceDeleteRecoveryItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    await removeManualRecoveryEntryByItemId(this.deps.accountId, itemId)
    this.clearRecoveryCooldown(itemId)
    this.setInFlight(itemId, false)

    await this.deps.docStore.changeDocument(
      itemId,
      doc => {
        if (typeof doc.id !== 'string' || doc.id.length === 0) {
          doc.id = itemId
        }
        doc.deleted = true
      },
      { createIfMissing: true },
    )

    await this.deps.indexManager.addAutomergeItemIdsToIndex([itemId])
    await this.pushRecoveryItems()
  }

  async dismissRecoveryItem(entryId: string): Promise<void> {
    if (!this.deps.accountId) return
    await removeManualRecoveryEntryById(this.deps.accountId, entryId)
    await this.pushRecoveryItems()
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    if (!this.deps.accountId) return []
    return await readManualRecoveryEntries(this.deps.accountId)
  }
}
