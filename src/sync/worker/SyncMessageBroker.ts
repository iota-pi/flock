import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncPoller, type PollOutcome } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import type { ItemId } from 'src/shared/schemas/items'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId } from './utils/automerge'
import { type DocumentId, type Message } from '@automerge/automerge-repo/slim'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { isQuotaError } from '../../utils/storageQuota'

export class SyncMessageBroker {
  private account: string | null = null
  private isOnline = true
  private sendEnabled = false

  private syncPoller: SyncPoller
  private wal: SyncWriteAheadLog | null = null
  private readonly snapshotOnlyItems = new Set<ItemId>()
  private blockedItemIds = new Set<ItemId>()
  private unsubscribeClientEvents: (() => void) | null = null

  public onFlushNeeded: (() => void) | null = null
  public onItemMessageParsed: ((itemId: ItemId) => void) | null = null
  public onWalAppendFailed: ((itemId: ItemId, error: unknown) => void) | null = null
  public onWalEntriesPruned: ((itemIds: ItemId[]) => void) | null = null

  constructor(
    private adapter: VaultNetworkAdapter,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private indexManager: AutomergeIndexManager | undefined,
    private pullQueueManager: SyncPullQueueManager,
    wal?: SyncWriteAheadLog | null,
  ) {
    this.setWal(wal ?? null)

    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      if (this.account) {
        this.onItemMessageParsed?.(itemId)
      }
      this.adapter.receiveMessage(documentId, message)
    }

    this.syncPoller = new SyncPoller(
      this.pullQueueManager,
      this.clientEventHub,
      this.internalEventHub,
      this.indexManager,
      this.wal,
    )

    this.syncPoller.onPushAcknowledged = (itemId, heads) => {
      this.unblockItem(itemId)
      const documentId = toDocumentIdFromItemId(itemId)
      this.adapter.setSyncedHeads(documentId, heads)
      this.adapter.resetReNegotiationCircuit(documentId)
    }

    this.unsubscribeClientEvents = this.clientEventHub.subscribe(event => {
      if (event.type === 'quotaResolved') {
        this.unblockAllItems()
        this.adapter.resetReNegotiationCircuit()
      }
    })

    this.adapter.onMessageToSend = (msg: Message) => {
      void this.handleOutgoingMessage(msg)
    }
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

  setSyncedHeads(documentId: DocumentId, heads: string[]): void {
    const itemId = toVaultItemIdFromAutomergeId(documentId)
    this.unblockItem(itemId)
    this.snapshotOnlyItems.delete(itemId)
    this.adapter.setSyncedHeads(documentId, heads)
    this.adapter.resetReNegotiationCircuit(documentId)
  }

  setSyncedHeadsForItem(itemId: ItemId, heads: string[]): void {
    this.unblockItem(itemId)
    this.snapshotOnlyItems.delete(itemId)
    const documentId = toDocumentIdFromItemId(itemId)
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
      const wal = this.account ? new SyncWriteAheadLog(this.account) : null
      this.setWal(wal)
    }

    await this.pullQueueManager.setAccount(this.account)
    this.syncPoller.setAccount(this.account)
  }

  setWal(wal: SyncWriteAheadLog | null): void {
    this.wal = wal
    if (this.wal) {
      this.unblockAllItems()
      this.wal.onEntriesPruned = itemIds => this.handleWalEntriesPruned(itemIds)
    }
    if (this.syncPoller) {
      this.syncPoller.setWal(this.wal)
    }
  }

  private handleWalEntriesPruned(itemIds: ItemId[]): void {
    for (const itemId of itemIds) {
      this.snapshotOnlyItems.add(itemId)
    }
    this.onWalEntriesPruned?.(itemIds)
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
        // Forward to onWalEntriesPruned callback to ensure dirty snapshot state is refreshed.
        this.onWalEntriesPruned?.([itemId])
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
    this.onWalAppendFailed?.(itemId, err)
    if (isQuotaError(err)) {
      this.clientEventHub.emit({
        type: 'quotaExceeded',
        message: 'Storage quota exceeded. Some changes could not be saved.',
      })
    }
  }

  flush(): void {
    this.onFlushNeeded?.()
  }

  exportCursors(): [ItemId, number][] {
    return this.pullQueueManager.exportCursors()
  }

  async importCursors(cursors: [ItemId, number][]): Promise<void> {
    await this.pullQueueManager.importCursors(cursors)
  }

  async loadCursors(): Promise<void> {
    await this.pullQueueManager.loadCursors()
  }

  async resetCursors(): Promise<void> {
    await this.pullQueueManager.resetCursors()
  }

  async executePoll(): Promise<PollOutcome> {
    return await this.syncPoller.executePoll()
  }

  hasPendingPulls(): boolean {
    return this.pullQueueManager.hasPendingPulls()
  }

  hasImmediatePendingPulls(): boolean {
    return this.pullQueueManager.hasImmediatePendingPulls()
  }

  abortPoll(): void {
    this.syncPoller.abort()
  }

  async shutdown(): Promise<void> {
    this.unsubscribeClientEvents?.()
    this.unsubscribeClientEvents = null
    this.unblockAllItems()
    this.snapshotOnlyItems.clear()
    this.syncPoller.shutdown()
    await this.pullQueueManager.shutdown()
  }
}

