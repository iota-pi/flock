import { SyncPullQueueManager } from './SyncPullQueueManager'
import type { SyncSessionState } from './SyncSessionState'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { VaultNetworkAdapter } from './VaultNetworkAdapter'
import type { ItemId } from '@vault/shared'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId } from './utils/automerge'
import { type DocumentId, type Message } from '@automerge/automerge-repo/slim'
import type { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { isQuotaError } from '../utils/storageQuota'
import { MAX_INCREMENTAL_MESSAGE_BYTES } from '@vault/shared'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncMessageBroker')

export interface SyncMessageBrokerDeps {
  adapter: VaultNetworkAdapter
  clientEventHub: ClientEventHub
  internalEventHub: WorkerInternalEventHub
  pullQueueManager: SyncPullQueueManager
  /** Only the leader writes outgoing messages to the WAL */
  session: SyncSessionState
  wal: SyncWriteAheadLog
  /** Frees space after a WAL append runs out of storage. Without it, the app is told the quota was exceeded. */
  onQuotaExceeded?: (error: unknown) => Promise<void>
}

export class SyncMessageBroker {
  private readonly session: SyncSessionState
  private readonly wal: SyncWriteAheadLog
  private readonly snapshotOnlyItems = new Set<ItemId>()
  private blockedItemIds = new Set<ItemId>()
  private unsubscribeClientEvents: (() => void) | null = null
  private unsubscribeInternalEvents: (() => void) | null = null
  private readonly adapter: VaultNetworkAdapter
  private readonly clientEventHub: ClientEventHub
  private readonly internalEventHub: WorkerInternalEventHub
  private readonly pullQueueManager: SyncPullQueueManager
  private readonly onQuotaExceeded?: (error: unknown) => Promise<void>

  constructor(deps: SyncMessageBrokerDeps) {
    this.adapter = deps.adapter
    this.clientEventHub = deps.clientEventHub
    this.internalEventHub = deps.internalEventHub
    this.pullQueueManager = deps.pullQueueManager
    this.onQuotaExceeded = deps.onQuotaExceeded
    this.wal = deps.wal
    this.session = deps.session

    this.unsubscribeInternalEvents = this.internalEventHub.subscribe(event => {
      switch (event.type) {
        case 'messageToSend':
          fireAndForget(this.handleOutgoingMessage(event.message), 'SyncMessageBroker:handleOutgoingMessage')
          break
        case 'messageParsed':
          this.internalEventHub.emit({ type: 'itemMessageParsed', itemId: event.itemId })
          this.adapter.receiveServerMessage(event.documentId, event.message)
          break
        case 'pushAcknowledged':
          this.recordSyncedHeads(event.itemId, event.heads)
          break
        case 'walEntriesPruned':
          this.handleWalEntriesPruned(event.itemIds)
          break
      }
    })

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

  getBlockedItemIds(): ItemId[] {
    return Array.from(this.blockedItemIds)
  }

  /** Records heads the server has confirmed from a snapshot, which also ends snapshot-only sync for the item. */
  setSyncedHeads(itemId: ItemId, heads: string[]): void {
    this.snapshotOnlyItems.delete(itemId)
    this.recordSyncedHeads(itemId, heads)
  }

  private recordSyncedHeads(itemId: ItemId, heads: string[]): void {
    const documentId = toDocumentIdFromItemId(itemId)
    this.unblockItem(itemId)
    this.adapter.setSyncedHeads(documentId, heads)
    this.adapter.resetReNegotiationCircuit(documentId)
  }

  clearSnapshotOnlyItem(itemId: ItemId): void {
    this.snapshotOnlyItems.delete(itemId)
  }

  /**
   * Routes an item to snapshot-only sync until its next successful snapshot push.
   */
  fallbackToSnapshot(itemId: ItemId): void {
    this.snapshotOnlyItems.add(itemId)
    this.internalEventHub.emit({ type: 'snapshotFallbackRequested', itemId })
  }

  private handleWalEntriesPruned(itemIds: ItemId[]): void {
    for (const itemId of itemIds) {
      this.snapshotOnlyItems.add(itemId)
    }
  }

  private async handleOutgoingMessage(message: Message): Promise<void> {
    try {
      if (!this.session.isLeader || this.session.isShutdown) {
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
          log.warn(`Dropping outgoing sync message for blocked item ${itemId}`)
          return
        }

        if (this.snapshotOnlyItems.has(itemId)) {
          // Item was pruned from WAL and is flagged for snapshot-only sync.
          // Drop incremental sync message to avoid re-filling WAL and causing thrashing.
          return
        }

        if (message.data.byteLength > MAX_INCREMENTAL_MESSAGE_BYTES) {
          log.warn(
            `Sync message for item ${itemId} (${message.data.byteLength} bytes) exceeds the incremental limit; falling back to snapshot sync`
          )
          this.fallbackToSnapshot(itemId)
          return
        }

        try {
          await this.wal.append(itemId, message.data)
          this.flush()
        } catch (err) {
          log.error(`Failed to append sync message to WAL for item ${itemId}:`, err)
          this.handleWalAppendFailure(itemId, documentId as DocumentId, err)
        }
      }
    } catch (err) {
      log.error('Error handling outgoing message:', err)
    }
  }

  private handleWalAppendFailure(itemId: ItemId, documentId: DocumentId, err: unknown): void {
    this.blockItem(itemId)
    this.adapter.triggerReNegotiation(documentId)
    this.internalEventHub.emit({ type: 'walAppendFailed', itemId, error: err })
    if (isQuotaError(err)) {
      if (this.onQuotaExceeded) {
        fireAndForget(this.onQuotaExceeded(err), 'SyncMessageBroker:handleQuotaExceeded')
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

  shutdown(): void {
    this.unsubscribeClientEvents?.()
    this.unsubscribeClientEvents = null
    this.unsubscribeInternalEvents?.()
    this.unsubscribeInternalEvents = null
    this.unblockAllItems()
    this.snapshotOnlyItems.clear()
  }
}

