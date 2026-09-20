import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncPoller } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import type { ItemId } from 'src/shared/schemas/items'
import { AutomergeIndexManager } from './docStore'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId } from './utils/automerge'
import { type DocumentId, type Message } from '@automerge/automerge-repo/slim'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { isQuotaError } from '../../utils/storageQuota'
import type { StorageRecoveryService } from './StorageRecoveryService'
import type { SyncApiClient } from './SyncApiClient'

export interface SyncBrokerControl {
  setOnlineState(isOnline: boolean): void
  setSendEnabled(sendEnabled: boolean): void
}

export class SyncMessageBroker implements SyncBrokerControl {
  private account: string | null = null
  private isOnline = true
  private sendEnabled = false

  private syncPoller: SyncPoller
  private wal: SyncWriteAheadLog | null = null
  private storageRecovery: StorageRecoveryService | null = null
  private readonly snapshotOnlyItems = new Set<ItemId>()
  private blockedItemIds = new Set<ItemId>()
  private unsubscribeClientEvents: (() => void) | null = null
  private unsubscribeInternalEvents: (() => void) | null = null

  constructor(
    private adapter: VaultNetworkAdapter,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private indexManager: AutomergeIndexManager | undefined,
    private pullQueueManager: SyncPullQueueManager,
    wal?: SyncWriteAheadLog | null,
    storageRecovery?: StorageRecoveryService | null,
    apiClient?: SyncApiClient,
  ) {
    this.storageRecovery = storageRecovery ?? null
    this.adapter?.setInternalEventHub?.(this.internalEventHub)
    this.pullQueueManager?.setInternalEventHub?.(this.internalEventHub)
    this.setWal(wal ?? null)

    this.unsubscribeInternalEvents = this.internalEventHub.subscribe(event => {
      switch (event.type) {
        case 'messageToSend':
          void this.handleOutgoingMessage(event.message)
          break
        case 'messageParsed':
          if (this.account) {
            this.internalEventHub.emit({ type: 'itemMessageParsed', itemId: event.itemId })
          }
          this.adapter.receiveMessage(event.documentId, event.message)
          break
        case 'pushAcknowledged':
          this.unblockItem(event.itemId)
          {
            const documentId = toDocumentIdFromItemId(event.itemId)
            this.adapter.setSyncedHeads(documentId, event.heads)
            this.adapter.resetReNegotiationCircuit(documentId)
          }
          break
        case 'walEntriesPruned':
          this.handleWalEntriesPruned(event.itemIds)
          break
      }
    })

    this.syncPoller = new SyncPoller(
      this.pullQueueManager,
      this.clientEventHub,
      this.internalEventHub,
      this.indexManager,
      this.wal,
      apiClient,
    )

    this.unsubscribeClientEvents = this.clientEventHub.subscribe(event => {
      if (event.type === 'quotaResolved') {
        const previouslyBlocked = Array.from(this.blockedItemIds)
        this.unblockAllItems()
        this.adapter.resetReNegotiationCircuit()
        for (const itemId of previouslyBlocked) {
          const documentId = toDocumentIdFromItemId(itemId)
          this.adapter.triggerReNegotiation(documentId)
        }
      }
    })
  }

  setStorageRecoveryService(storageRecovery: StorageRecoveryService | null): void {
    this.storageRecovery = storageRecovery
  }

  getStorageRecoveryService(): StorageRecoveryService | null {
    return this.storageRecovery
  }

  getWal(): SyncWriteAheadLog | null {
    return this.wal
  }

  blockItem(itemId: ItemId): void {
    this.blockedItemIds.add(itemId)
  }

  unblockItem(itemId: ItemId): void {
    this.blockedItemIds.delete(itemId)
  }

  unblockAllItems(): void {
    this.blockedItemIds.clear()
  }

  isItemBlocked(itemId: ItemId): boolean {
    return this.blockedItemIds.has(itemId)
  }

  getBlockedItemCount(): number {
    return this.blockedItemIds.size
  }

  getBlockedItemIds(): ItemId[] {
    return Array.from(this.blockedItemIds)
  }

  setSyncedHeads(id: ItemId | DocumentId, heads: string[]): void {
    const decodedItemId = toVaultItemIdFromAutomergeId(id as DocumentId)
    const isDocumentId = toDocumentIdFromItemId(decodedItemId) === id
    const itemId = isDocumentId ? decodedItemId : (id as ItemId)
    const documentId = isDocumentId ? (id as DocumentId) : toDocumentIdFromItemId(id as ItemId)

    this.unblockItem(itemId)
    this.snapshotOnlyItems.delete(itemId)
    this.adapter.setSyncedHeads(documentId, heads)
    this.adapter.resetReNegotiationCircuit(documentId)
  }

  clearSnapshotOnlyItem(itemId: ItemId): void {
    this.snapshotOnlyItems.delete(itemId)
  }

  isSnapshotOnly(itemId: ItemId): boolean {
    return this.snapshotOnlyItems.has(itemId)
  }

  markSnapshotOnly(itemId: ItemId): void {
    this.snapshotOnlyItems.add(itemId)
  }

  getSnapshotOnlyItemCount(): number {
    return this.snapshotOnlyItems.size
  }

  setSendEnabled(sendEnabled: boolean): void {
    this.sendEnabled = sendEnabled
    this.adapter.setSendEnabled(sendEnabled)
  }

  clearSeededDocuments(): void {
    this.adapter.clearSeededDocuments()
  }

  async setAccount(account: string | null): Promise<void> {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.unblockAllItems()
    this.snapshotOnlyItems.clear()
    this.account = nextAccount
    if (!this.wal || this.wal.accountId !== this.account) {
      const wal = this.account ? new SyncWriteAheadLog(this.account, this.internalEventHub) : null
      this.setWal(wal)
    }

    await this.pullQueueManager.setAccount(this.account)
    this.syncPoller.setAccount(this.account)
  }

  setWal(wal: SyncWriteAheadLog | null): void {
    this.wal = wal
    if (this.wal) {
      this.unblockAllItems()
      this.wal.setInternalEventHub(this.internalEventHub)
    }
    if (this.syncPoller) {
      this.syncPoller.setWal(this.wal)
    }
  }

  private handleWalEntriesPruned(itemIds: ItemId[]): void {
    for (const itemId of itemIds) {
      this.snapshotOnlyItems.add(itemId)
    }
  }

  setOnlineState(isOnline: boolean): void {
    if (this.isOnline === isOnline) {
      return
    }

    this.isOnline = isOnline
    this.syncPoller.setOnlineState(isOnline)
  }

  private async handleOutgoingMessage(message: Message): Promise<void> {
    if (!this.sendEnabled || !this.account) {
      return
    }

    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId) {
      return
    }

    const itemId = toVaultItemIdFromAutomergeId(documentId)

    if (message.type === 'request') {
      this.pullQueueManager.addPendingItem(itemId)
      this.flush()
    } else if (message.type === 'sync' && message.data instanceof Uint8Array) {
      if (this.isItemBlocked(itemId)) {
        console.warn(`[SyncMessageBroker] Dropping outgoing sync message for blocked item ${itemId}`)
        return
      }

      if (this.snapshotOnlyItems.has(itemId)) {
        // Item was pruned from WAL and is flagged for snapshot-only sync.
        // Drop incremental sync message to avoid re-filling WAL and causing thrashing.
        // Emit walEntriesPruned to ensure dirty snapshot state is refreshed.
        this.internalEventHub.emit({ type: 'walEntriesPruned', itemIds: [itemId] })
        return
      }

      if (this.wal) {
        try {
          await this.wal.append(itemId, message.data)
          this.flush()
        } catch (err) {
          console.error(`[SyncMessageBroker] Failed to append sync message to WAL for item ${itemId}:`, err)
          this.handleWalAppendFailure(itemId, documentId as DocumentId, err)
        }
      } else {
        console.warn(`[SyncMessageBroker] WAL unavailable for item ${itemId}, falling back to snapshot sync`)
        this.handleWalAppendFailure(itemId, documentId as DocumentId, new Error('WAL not initialized'))
      }
    }
  }

  private handleWalAppendFailure(itemId: ItemId, documentId: DocumentId, err: unknown): void {
    this.blockItem(itemId)
    this.adapter.triggerReNegotiation(documentId)
    this.internalEventHub.emit({ type: 'walAppendFailed', itemId, error: err })
    if (isQuotaError(err)) {
      if (this.storageRecovery) {
        void this.storageRecovery.handleQuotaExceeded(err)
      } else {
        this.clientEventHub.emit({
          type: 'quotaExceeded',
          message: 'Storage quota exceeded. Some changes could not be saved.',
        })
      }
    }
  }

  flush(): void {
    this.internalEventHub.emit({ type: 'flushNeeded' })
  }

  get poller(): SyncPoller {
    return this.syncPoller
  }

  async shutdown(): Promise<void> {
    this.unsubscribeClientEvents?.()
    this.unsubscribeClientEvents = null
    this.unsubscribeInternalEvents?.()
    this.unsubscribeInternalEvents = null
    this.unblockAllItems()
    this.snapshotOnlyItems.clear()
    this.syncPoller.shutdown()
    await this.pullQueueManager.shutdown()
  }
}

