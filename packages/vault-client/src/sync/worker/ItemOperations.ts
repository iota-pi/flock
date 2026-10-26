import type { VaultDoc } from '../shared/types'
import type { SyncDomainHooks } from './domain'
import { ClientEventHub } from './SyncEventHub'
import { AutomergeDocStore, AutomergeIndexManager } from './docStore'
import { generateItemId, settingsDocId, type ItemId } from '@vault/shared'
import { MAX_ITEM_CONTENT_BYTES, MAX_ITEM_CONTENT_KB } from '@vault/shared'
import { mutateDraftToMatchSnapshot } from './utils/snapshot'
import { applyItemUpdatesToDraft } from './utils/crdtReconcile'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import type { RecoveryManager } from './RecoveryManager'
import { KeyedSingleFlightGuard } from '../utils/SingleFlightGuard'
import { createLogger } from '../utils/logger'
import { errorMessage } from '../utils/errorMessage'

const log = createLogger('ItemOperations')

export interface ItemOperationsDeps {
  accountId: string
  docStore: AutomergeDocStore
  indexManager: AutomergeIndexManager
  eventHub: ClientEventHub
  markDocumentDirty: (itemId: ItemId) => void
  recoveryManager: RecoveryManager
  hooks?: SyncDomainHooks
}

export interface StoreItemsOptions {
  markDirty?: boolean
}

class DocumentCreateRefusedError extends Error {}

export class ItemOperations {
  public readonly recoveryManager: RecoveryManager
  private readonly recreateGuard = new KeyedSingleFlightGuard<ItemId, ItemId>()

  constructor(private deps: ItemOperationsDeps) {
    this.recoveryManager = deps.recoveryManager
  }

  private async applyDocumentChange(
    id: ItemId,
    itemOrChanges: Partial<VaultDoc>,
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

  async mutateItem(id: ItemId, changes: Partial<VaultDoc>): Promise<void> {
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
      await this.handleMutationFailure(id, 'edit', errorMessage(err))
    }
  }

  /**
   * Creates and indexes a document, throwing on any failure.
   * `documentCreated` on the thrown error distinguishes a refused change from an exception.
   */
  private async createDocumentOrThrow(item: VaultDoc): Promise<void> {
    const updated = await this.applyDocumentChange(item.id, item, {
      createIfMissing: true,
      knownToExist: false,
    })
    if (updated !== true) {
      throw new DocumentCreateRefusedError(`Failed to create document ${item.id}`)
    }
    await this.deps.indexManager.addAutomergeItemIdsToIndex([item.id])
    this.deps.markDocumentDirty(item.id)
    publishRealtimeBusSyncPing(this.deps.accountId, [item.id])
  }

  async createItem(item: VaultDoc): Promise<void> {
    try {
      await this.createDocumentOrThrow(item)
    } catch (err) {
      const refused = err instanceof DocumentCreateRefusedError
      await this.handleMutationFailure(item.id, 'create', errorMessage(err), refused)
    }
  }

  async storeItems(items: VaultDoc[], options: StoreItemsOptions = {}): Promise<void> {
    const { markDirty = true } = options
    const failedItems: VaultDoc[] = []
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
      publishRealtimeBusSyncPing(this.deps.accountId, succeededActiveIds)
    }

    for (const item of failedItems) {
      await this.emitTrueState(item.id)
    }
  }

  /** The settings document has a fixed ID, so deleting or recreating it would lose it for good */
  private assertNotSettingsDoc(itemId: ItemId, action: string): void {
    if (this.deps.accountId && itemId === settingsDocId(this.deps.accountId)) {
      throw new Error(`Cannot ${action} the account settings document.`)
    }
  }

  // --- Document-level Recovery Operations ---

  async forceOverwriteRecoveryItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    const localItem = await this.deps.docStore.getAutomergeItem(itemId)
    if (!localItem) {
      throw new Error(`No local item found for ${itemId}. Force delete is available instead.`)
    }
    if (this.deps.docStore.codec.isCorrupt(localItem)) {
      throw new Error(`Cannot overwrite with corrupt local item ${itemId}. Force delete is available instead.`)
    }

    const localSnapshot = JSON.parse(JSON.stringify(localItem)) as Record<string, unknown>

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

    await this.recoveryManager.unquarantine(itemId)

    await this.deps.indexManager.addAutomergeItemIdsToIndex([itemId])
    this.deps.markDocumentDirty(itemId)
    publishRealtimeBusSyncPing(this.deps.accountId, [itemId])
    await this.recoveryManager.pushRecoveryItems()
  }

  async forceDeleteRecoveryItem(itemId: ItemId): Promise<void> {
    if (!this.deps.accountId) return
    this.assertNotSettingsDoc(itemId, 'delete')

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

    await this.recoveryManager.unquarantine(itemId)

    await this.deps.indexManager.removeAutomergeItemIdsFromIndex([itemId])
    this.deps.markDocumentDirty(itemId)
    await this.recoveryManager.pushRecoveryItems()
  }

  /**
   * Replaces an oversized item with a fresh copy (new id, no edit history) and soft-deletes the old one.
   * The old item is only touched once the new document exists and is indexed, so a failure leaves it
   * intact (and quarantined) and the call is safe to retry. If the source is already deleted, a previous
   * recreation is finalised instead: no new copy is made and the old id is returned.
   */
  async recreateOversizedItem(oldItemId: ItemId): Promise<ItemId> {
    return this.recreateGuard.run(oldItemId, () => this.performRecreateOversizedItem(oldItemId))
  }

  private async performRecreateOversizedItem(oldItemId: ItemId): Promise<ItemId> {
    if (!this.deps.accountId) {
      throw new Error('Account ID is required to recreate oversized item.')
    }
    this.assertNotSettingsDoc(oldItemId, 'recreate')
    const localItem = await this.deps.docStore.getAutomergeItem(oldItemId)
    if (!localItem) {
      throw new Error(`No local item found for ${oldItemId} to recreate.`)
    }

    if (localItem.deleted === true) {
      await this.deps.indexManager.removeAutomergeItemIdsFromIndex([oldItemId])
      this.deps.markDocumentDirty(oldItemId)
      await this.recoveryManager.unquarantine(oldItemId)
      await this.recoveryManager.pushRecoveryItems()
      this.deps.eventHub.emit({ type: 'itemUpdated', id: oldItemId, item: null })
      return oldItemId
    }

    const payloadJson = JSON.stringify(localItem)
    if (payloadJson.length > MAX_ITEM_CONTENT_BYTES) {
      throw new Error(
        `The content of this item is too large (over ${MAX_ITEM_CONTENT_KB} KB). Please edit and shorten the notes or description before recreating.`,
      )
    }

    const newItemId = generateItemId()
    const cleanItemSnapshot = JSON.parse(payloadJson) as VaultDoc
    const copiedItem: VaultDoc = {
      ...cleanItemSnapshot,
      id: newItemId,
      deleted: false,
    }
    const newItem = this.deps.hooks?.prepareRecreatedDoc?.(copiedItem) ?? copiedItem

    // 1. Create the new clean document and register in index
    try {
      await this.createDocumentOrThrow(newItem)
    } catch (cause) {
      if (!(cause instanceof DocumentCreateRefusedError)) {
        // The document may exist without being indexed, so retire it on a best-effort basis
        try {
          await this.deps.docStore.changeDocument(
            newItemId,
            doc => {
              doc.deleted = true
            },
            { knownToExist: true },
          )
          this.deps.markDocumentDirty(newItemId)
        } catch {
          // Cleanup is best-effort; the old item is untouched either way
        }
      }
      throw new Error(
        `Failed to recreate item ${oldItemId}: ${errorMessage(cause)}`,
        { cause },
      )
    }

    // 2. Repoint references from other active items to the new id
    const remapReferences = this.deps.hooks?.remapReferences
    if (remapReferences) {
      try {
        const activeItemIds = await this.deps.indexManager.listAutomergeItemIds()
        for (const id of activeItemIds) {
          if (id === oldItemId || id === newItemId) continue
          const candidate = await this.deps.docStore.getAutomergeItem(id)
          const changes = candidate ? remapReferences(candidate, oldItemId, newItemId) : null
          if (!changes) continue
          const updated = await this.applyDocumentChange(id, changes, { knownToExist: true })
          if (updated) {
            this.deps.markDocumentDirty(id)
            const updatedItem = await this.deps.docStore.getAutomergeItem(id)
            this.deps.eventHub.emit({ type: 'itemUpdated', id, item: updatedItem })
          }
        }
      } catch (remapErr) {
        log.warn(`Error remapping references to ${oldItemId}:`, remapErr)
      }
    }

    // 3. Mark old oversized item as deleted in Automerge document & remove from active index
    const oldMarkedDeleted = await this.deps.docStore.changeDocument(
      oldItemId,
      doc => {
        doc.deleted = true
      },
      { knownToExist: true },
    )
    if (!oldMarkedDeleted) {
      throw new Error(`New item ${newItemId} was created but ${oldItemId} could not be marked deleted`)
    }
    await this.deps.indexManager.removeAutomergeItemIdsFromIndex([oldItemId])
    this.deps.markDocumentDirty(oldItemId)

    // 4. Remove old item from quarantine
    await this.recoveryManager.unquarantine(oldItemId)
    await this.recoveryManager.pushRecoveryItems()

    // 5. Notify subscribers & ping bus
    publishRealtimeBusSyncPing(this.deps.accountId, [oldItemId, newItemId])
    this.deps.eventHub.emit({ type: 'itemUpdated', id: oldItemId, item: null })
    this.deps.eventHub.emit({ type: 'itemUpdated', id: newItemId, item: newItem })

    return newItemId
  }
}
