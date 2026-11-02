import type { SyncPullQueueManager } from './SyncPullQueueManager'
import type { SyncSessionState } from './SyncSessionState'
import type { VaultNetworkAdapter } from './VaultNetworkAdapter'
import type { ItemId } from '@vault/shared'
import { toDocumentIdFromItemId, toVaultItemIdFromAutomergeId } from './utils/automerge'
import type { DocumentId, Message } from '@automerge/automerge-repo/slim'
import type { SyncWriteAheadLog } from './SyncWriteAheadLog'
import { MAX_INCREMENTAL_MESSAGE_BYTES } from '@vault/shared'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncMessageBroker')

export interface SyncMessageBrokerDeps {
  adapter: VaultNetworkAdapter
  pullQueueManager: SyncPullQueueManager
  /** Only the leader writes outgoing messages to the WAL */
  session: SyncSessionState
  wal: SyncWriteAheadLog
  /** Asks the orchestrator to push what's in the WAL and pull pending items */
  onFlushNeeded: () => void
  /** Marks items for an immediate snapshot, which delivers what incremental sync couldn't */
  requestSnapshot: (itemIds: ItemId[]) => void
}

export class SyncMessageBroker {
  private readonly session: SyncSessionState
  private readonly wal: SyncWriteAheadLog
  private readonly snapshotOnlyItems = new Set<ItemId>()
  private readonly blockedItemIds = new Set<ItemId>()
  private readonly adapter: VaultNetworkAdapter
  private readonly pullQueueManager: SyncPullQueueManager
  private readonly onFlushNeeded: () => void
  private readonly requestSnapshot: (itemIds: ItemId[]) => void

  constructor(deps: SyncMessageBrokerDeps) {
    this.adapter = deps.adapter
    this.pullQueueManager = deps.pullQueueManager
    this.wal = deps.wal
    this.session = deps.session
    this.onFlushNeeded = deps.onFlushNeeded
    this.requestSnapshot = deps.requestSnapshot
  }

  /** Takes an outgoing message from the adapter: a change goes to the WAL, a request to the pull queue */
  send(message: Message): void {
    fireAndForget(this.handleOutgoingMessage(message), 'SyncMessageBroker:handleOutgoingMessage')
  }

  unblockAllItems(): void {
    this.blockedItemIds.clear()
  }

  getBlockedItemIds(): ItemId[] {
    return Array.from(this.blockedItemIds)
  }

  /**
   * Records a snapshot the server stored: ends snapshot-only sync for the item, unblocks it and records
   * its heads. Tombstones carry no heads, since the server does not hold the document state.
   */
  confirmSnapshot(itemId: ItemId, heads: string[] | undefined): void {
    this.snapshotOnlyItems.delete(itemId)
    if (heads && heads.length > 0) {
      this.recordSyncedHeads(itemId, heads)
    } else {
      this.blockedItemIds.delete(itemId)
    }
  }

  /** Records heads the server has confirmed from a push. Snapshot-only sync continues. */
  recordSyncedHeads(itemId: ItemId, heads: string[]): void {
    const documentId = toDocumentIdFromItemId(itemId)
    this.blockedItemIds.delete(itemId)
    this.adapter.setSyncedHeads(documentId, heads)
    this.adapter.resetReNegotiationCircuit(documentId)
  }

  /**
   * Routes items to snapshot-only sync until their next successful snapshot push, and requests that
   * snapshot. Also called for items whose WAL entries were pruned.
   */
  fallbackToSnapshot(itemIds: ItemId[]): void {
    for (const itemId of itemIds) {
      this.snapshotOnlyItems.add(itemId)
    }
    this.requestSnapshot(itemIds)
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
        this.pullQueueManager.cursors.addPendingItem(itemId)
        this.onFlushNeeded()
      } else if (message.type === 'sync' && message.data instanceof Uint8Array) {
        if (this.blockedItemIds.has(itemId)) {
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
          this.fallbackToSnapshot([itemId])
          return
        }

        try {
          await this.wal.append(itemId, message.data)
          this.onFlushNeeded()
        } catch (err) {
          log.error(`Failed to append sync message to WAL for item ${itemId}:`, err)
          this.handleWalAppendFailure(itemId, documentId as DocumentId)
        }
      }
    } catch (err) {
      log.error('Error handling outgoing message:', err)
    }
  }

  private handleWalAppendFailure(itemId: ItemId, documentId: DocumentId): void {
    this.blockedItemIds.add(itemId)
    this.adapter.triggerReNegotiation(documentId)
    this.requestSnapshot([itemId])
  }

  shutdown(): void {
    this.blockedItemIds.clear()
    this.snapshotOnlyItems.clear()
  }
}

