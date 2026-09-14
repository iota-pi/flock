import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { ClientEventHub } from './SyncEventHub'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import type { ItemId } from 'src/shared/schemas/items'
import type { ManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { mutateDraftToMatchSnapshot } from './utils/snapshot'
import { applyItemUpdatesToDraft } from './utils/crdtReconcile'
import { normalizeSyncError } from 'src/shared/syncErrors'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { hasApiAuthToken } from '../../api/runtime'
import { getTrpcClient } from '../../api/trpcClient'
import { extractSyncableMetadata, hasSyncableChanges } from './utils/metadataSync'
import { RecoveryManager, RECOVERY_RETRY_COOLDOWN_MS } from './RecoveryManager'

export { RECOVERY_RETRY_COOLDOWN_MS }

export interface ItemOperationsDeps {
  accountId: string
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  eventHub: ClientEventHub
  markDocumentDirty: (itemId: ItemId) => void
  recoveryManager?: RecoveryManager
}

export interface StoreItemsOptions {
  markDirty?: boolean
}

export class ItemOperations {
  private recoveryManager: RecoveryManager

  constructor(private deps: ItemOperationsDeps) {
    this.recoveryManager = deps.recoveryManager ?? new RecoveryManager({
      accountId: deps.accountId,
      eventHub: deps.eventHub,
    })
  }

  private async applyDocumentChange(
    id: ItemId,
    itemOrChanges: Partial<Item>,
    options?: { createIfMissing?: boolean; knownToExist?: boolean },
  ): Promise<boolean> {
    return await this.deps.docStore.changeDocument(
      id,
      doc => {
        applyItemUpdatesToDraft(doc, itemOrChanges)
      },
      options,
    )
  }

  private async emitTrueState(id: ItemId): Promise<void> {
    try {
      const trueState = await this.deps.docStore.getAutomergeItem(id)
      this.deps.eventHub.emit({ type: 'itemUpdated', id, item: trueState })
    } catch {
      // Doc retrieval failure fallback
    }
  }

  private async handleMutationFailure(
    id: ItemId,
    mutationType: 'edit' | 'create',
    error: string,
    syncTrueState = true,
  ): Promise<void> {
    this.deps.eventHub.emit({ type: 'mutationFailed', mutationType, error })
    if (syncTrueState) {
      await this.emitTrueState(id)
    }
  }

  async mutateItem(id: ItemId, changes: Partial<Item>): Promise<void> {
    try {
      const updated = await this.applyDocumentChange(id, changes, { knownToExist: true })
      if (updated) {
        if (changes.deleted === true) {
          await this.deps.indexManager.removeAutomergeItemIdsFromIndex([id])
        } else if (changes.deleted === false) {
          await this.deps.indexManager.addAutomergeItemIdsToIndex([id])
        }
        this.deps.markDocumentDirty(id)
      } else {
        await this.handleMutationFailure(id, 'edit', `Failed to update document ${id}`)
      }
    } catch (err) {
      await this.handleMutationFailure(id, 'edit', (err as Error).message)
    }
  }

  async createItem(item: Item): Promise<void> {
    try {
      const updated = await this.applyDocumentChange(item.id, item, {
        createIfMissing: true,
        knownToExist: false,
      })
      if (updated) {
        await this.deps.indexManager.addAutomergeItemIdsToIndex([item.id])
        this.deps.markDocumentDirty(item.id)
        publishRealtimeBusSyncPing([item.id])
      } else {
        await this.handleMutationFailure(item.id, 'create', `Failed to create document ${item.id}`)
      }
    } catch (err) {
      await this.handleMutationFailure(item.id, 'create', (err as Error).message, false)
    }
  }

  async storeItems(items: Item[], options: StoreItemsOptions = {}): Promise<void> {
    const { markDirty = true } = options
    const failedItems: Item[] = []
    const succeededActiveIds: ItemId[] = []
    const succeededDeletedIds: ItemId[] = []
    const existingIds = new Set(await this.deps.indexManager.listAutomergeItemIds())

    for (const item of items) {
      try {
        const updated = await this.applyDocumentChange(item.id, item, {
          createIfMissing: true,
          knownToExist: existingIds.has(item.id),
        })
        if (updated) {
          if (item.deleted) {
            succeededDeletedIds.push(item.id)
          } else {
            succeededActiveIds.push(item.id)
          }
          if (markDirty) {
            this.deps.markDocumentDirty(item.id)
          }
        } else {
          failedItems.push(item)
        }
      } catch {
        failedItems.push(item)
      }
    }

    if (succeededDeletedIds.length > 0) {
      await this.deps.indexManager.removeAutomergeItemIdsFromIndex(succeededDeletedIds)
    }

    if (succeededActiveIds.length > 0) {
      await this.deps.indexManager.addAutomergeItemIdsToIndex(succeededActiveIds)
      publishRealtimeBusSyncPing(succeededActiveIds)
    }

    for (const item of failedItems) {
      await this.emitTrueState(item.id)
    }
  }

  async mutateMetadata(
    changes: Partial<AccountMetadata>,
    options?: { pushRemote?: boolean },
  ): Promise<void> {
    try {
      const isSyncable = hasSyncableChanges(changes)
      const nextChanges: Partial<AccountMetadata> = isSyncable
        ? { ...changes, updatedAt: changes.updatedAt ?? Date.now() }
        : changes

      const updated = await this.deps.indexManager.updateAutomergeMetadata(nextChanges)

      const shouldPush = (options?.pushRemote ?? true) && isSyncable
      if (shouldPush && hasApiAuthToken() && this.deps.accountId) {
        const syncablePayload = extractSyncableMetadata(updated)
        try {
          await getTrpcClient().accounts.updateMetadata.mutate({
            account: this.deps.accountId,
            metadata: syncablePayload,
          })
        } catch (pushErr) {
          console.warn('[ItemOperations] Failed to push metadata to server (will retry on next sync):', pushErr)
        }
      }
    } catch (err) {
      this.deps.eventHub.emit({ type: 'mutationFailed', mutationType: 'metadata', error: (err as Error).message })
      const metadata = await this.deps.indexManager.getAutomergeMetadata()
      this.deps.eventHub.emit({ type: 'metadataUpdated', metadata })
    }
  }

  // --- Manual Recovery & Lifecycle Management ---

  isInFlight(itemId: ItemId): boolean {
    return this.recoveryManager.isInFlight(itemId)
  }

  setInFlight(itemId: ItemId, inFlight: boolean): void {
    this.recoveryManager.setInFlight(itemId, inFlight)
  }

  getRecoveryCooldownUntil(itemId: ItemId): number {
    return this.recoveryManager.getRecoveryCooldownUntil(itemId)
  }

  setRecoveryCooldown(itemId: ItemId, cooldownUntil: number): void {
    this.recoveryManager.setRecoveryCooldown(itemId, cooldownUntil)
  }

  clearRecoveryCooldown(itemId: ItemId): void {
    this.recoveryManager.clearRecoveryCooldown(itemId)
  }

  resetRecoveryState(): void {
    this.recoveryManager.resetRecoveryState()
  }

  reset(): void {
    this.recoveryManager.reset()
  }

  async pushRecoveryItems(): Promise<void> {
    await this.recoveryManager.pushRecoveryItems(this.deps.accountId)
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
    try {
      await this.recoveryManager.quarantine(
        this.deps.accountId,
        itemId,
        null,
        { checkCooldown: true, failedBranches },
      )
    } catch (error) {
      console.error('[ItemOperations] Failed to record manual recovery entry', error)
    }
  }

  async clearManualRecoveryForItems(itemIds: ItemId[]): Promise<void> {
    if (!this.deps.accountId) return
    await this.recoveryManager.unquarantineBatch(this.deps.accountId, itemIds)
  }

  async retryRecoveryItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    await this.recoveryManager.unquarantine(this.deps.accountId, itemId)
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

    await this.recoveryManager.unquarantine(this.deps.accountId, itemId)

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
    publishRealtimeBusSyncPing([itemId])
    await this.recoveryManager.pushRecoveryItems(this.deps.accountId)
  }

  async forceDeleteRecoveryItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    await this.recoveryManager.unquarantine(this.deps.accountId, itemId)

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
    await this.recoveryManager.pushRecoveryItems(this.deps.accountId)
  }

  async dismissRecoveryItem(entryId: string): Promise<void> {
    if (!this.deps.accountId) return
    await this.recoveryManager.dismissEntry(this.deps.accountId, entryId)
  }

  async compactItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    const localItem = await this.deps.docStore.getAutomergeItem(itemId)
    if (!localItem) {
      throw new Error(`No local item found for ${itemId} to compact.`)
    }

    await this.deps.docStore.compactDocument(itemId, localItem)

    await this.recoveryManager.unquarantine(this.deps.accountId, itemId)

    this.deps.markDocumentDirty(itemId)
    this.deps.eventHub.emit({ type: 'itemUpdated', id: itemId, item: localItem })
  }

  async listRecoveryItems(): Promise<ManualRecoveryEntry[]> {
    if (!this.deps.accountId) return []
    return await this.recoveryManager.listRecoveryItems(this.deps.accountId)
  }
}
