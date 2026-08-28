import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { ClientEventHub } from './SyncEventHub'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { ItemId } from 'src/shared/schemas/items'
import {
  type ManualRecoveryEntry,
  readManualRecoveryEntries,
  readManualRecoveryCount,
  removeManualRecoveryEntryById,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from '../shared/manualRecoveryStore'
import { mutateDraftToMatchSnapshot } from './utils/snapshot'
import { normalizeSyncError } from 'src/shared/syncErrors'

export const RECOVERY_RETRY_COOLDOWN_MS = 60 * 1000

export interface ItemOperationsDeps {
  accountId: string
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  eventHub: ClientEventHub
  markDocumentDirty: (itemId: ItemId) => void
}

export class ItemOperations {
  private inFlightItemIds = new Set<ItemId>()
  private cooldownUntilByItemId = new Map<ItemId, number>()

  constructor(private deps: ItemOperationsDeps) {}

  async mutateItem(id: ItemId, changes: Partial<Item>): Promise<void> {
    try {
      const updated = await this.deps.docStore.changeDocument(
        id,
        doc => {
          for (const [key, value] of Object.entries(changes)) {
            if (value === undefined) delete doc[key]
            else doc[key] = value
          }
        },
        { knownToExist: true },
      )
      if (updated) {
        this.deps.markDocumentDirty(id)
      } else {
        this.deps.eventHub.emit({ type: 'mutationFailed', mutationType: 'edit', error: `Failed to update document ${id}` })
        const trueState = await this.deps.docStore.getAutomergeItem(id)
        this.deps.eventHub.emit({ type: 'itemUpdated', id, item: trueState })
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationType: 'edit', error: (err as Error).message })
      try {
        const trueState = await this.deps.docStore.getAutomergeItem(id)
        this.deps.eventHub.emit({ type: 'itemUpdated', id, item: trueState })
      } catch {
        // Doc retrieval failure fallback
      }
    }
  }

  async createItem(item: Item): Promise<void> {
    try {
      const updated = await this.deps.docStore.changeDocument(
        item.id,
        doc => {
          for (const [key, value] of Object.entries(item)) {
            doc[key] = value
          }
        },
        { createIfMissing: true, knownToExist: false },
      )
      if (updated) {
        await this.deps.indexManager.addAutomergeItemIdsToIndex([item.id])
        this.deps.markDocumentDirty(item.id)
      } else {
        this.deps.eventHub.emit({ type: 'mutationFailed', mutationType: 'create', error: `Failed to create document ${item.id}` })
        const trueState = await this.deps.docStore.getAutomergeItem(item.id)
        this.deps.eventHub.emit({ type: 'itemUpdated', id: item.id, item: trueState })
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationType: 'create', error: (err as Error).message })
    }
  }

  async storeItems(items: Item[]): Promise<void> {
    const failedItems: Item[] = []
    const succeededIds: ItemId[] = []
    const existingIds = new Set(await this.deps.indexManager.listAutomergeItemIds())

    for (const item of items) {
      try {
        const updated = await this.deps.docStore.changeDocument(
          item.id,
          doc => {
            for (const [key, value] of Object.entries(item)) {
              if (value === undefined) delete doc[key]
              else doc[key] = value
            }
          },
          { createIfMissing: true, knownToExist: existingIds.has(item.id) },
        )
        if (updated) {
          succeededIds.push(item.id)
          this.deps.markDocumentDirty(item.id)
        } else {
          failedItems.push(item)
        }
      } catch {
        failedItems.push(item)
      }
    }

    if (succeededIds.length > 0) {
      await this.deps.indexManager.addAutomergeItemIdsToIndex(succeededIds)
    }

    for (const item of failedItems) {
      const trueState = await this.deps.docStore.getAutomergeItem(item.id)
      this.deps.eventHub.emit({ type: 'itemUpdated', id: item.id, item: trueState })
    }
  }

  async mutateMetadata(changes: Partial<AccountMetadata>): Promise<void> {
    try {
      await this.deps.indexManager.updateAutomergeMetadata(changes)
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationType: 'metadata', error: (err as Error).message })
      const metadata = await this.deps.indexManager.getAutomergeMetadata()
      this.deps.eventHub.emit({ type: 'metadataUpdated', metadata })
    }
  }

  // --- Manual Recovery & Lifecycle Management ---

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

  async pushRecoveryItems(): Promise<void> {
    if (!this.deps.accountId) return
    try {
      const entries = await readManualRecoveryEntries(this.deps.accountId)
      this.deps.eventHub.emit({ type: 'recoveryItemsChanged', entries })
    } catch (error) {
      console.error('[ItemOperations] Failed to push recovery entries change', error)
    }
  }

  async reportDecryptionFailure(itemId: ItemId, error: unknown, failedBranches?: string[]): Promise<void> {
    const normalizedError = normalizeSyncError(error)
    console.error('[ItemOperations] Failed to decrypt item', {
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
      console.error('[ItemOperations] Failed to record manual recovery entry', error)
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
