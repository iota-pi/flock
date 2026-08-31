import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncPoller, type PollOutcome } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import type { ItemId } from 'src/shared/schemas/items'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { toVaultItemIdFromAutomergeId } from './utils/automerge'
import { type Message } from '@automerge/automerge-repo/slim'
import { SyncWriteAheadLog } from './SyncWriteAheadLog'

export class SyncMessageBroker {
  private account: string | null = null
  private isOnline = true
  private sendEnabled = false

  private syncPoller: SyncPoller
  private wal: SyncWriteAheadLog | null = null

  public onFlushNeeded: (() => void) | null = null
  public onItemMessageParsed: ((itemId: ItemId) => void) | null = null

  constructor(
    private adapter: VaultNetworkAdapter,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private indexManager: AutomergeIndexManager,
    private pullQueueManager: SyncPullQueueManager,
    wal?: SyncWriteAheadLog | null,
  ) {
    this.wal = wal ?? null

    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      if (this.account) {
        this.onItemMessageParsed?.(itemId)
      }
      this.adapter.receiveMessage(documentId, message)
      this.indexManager.addAutomergeItemIdsToIndex([itemId]).catch(console.error)
    }

    this.syncPoller = new SyncPoller(
      this.pullQueueManager,
      this.clientEventHub,
      this.internalEventHub,
      this.indexManager,
      this.wal,
    )

    this.adapter.onMessageToSend = (msg: Message) => {
      void this.handleOutgoingMessage(msg)
    }
  }

  setSendEnabled(sendEnabled: boolean): void {
    this.sendEnabled = sendEnabled
    this.adapter.setSendEnabled(sendEnabled)
  }

  async setAccount(account: string | null): Promise<void> {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount
    this.wal = this.account ? new SyncWriteAheadLog(this.account) : null
    this.syncPoller.setWal(this.wal)

    await this.pullQueueManager.setAccount(this.account)
    this.syncPoller.setAccount(this.account)
  }

  setWal(wal: SyncWriteAheadLog | null): void {
    this.wal = wal
    this.syncPoller.setWal(wal)
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
      if (this.wal) {
        try {
          await this.wal.append(itemId, message.data)
        } catch (err) {
          console.error('[SyncMessageBroker] Failed to append to WAL', err)
        }
      }
      this.flush()
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

  async resetCursors(): Promise<void> {
    await this.pullQueueManager.resetCursors()
  }

  async executePoll(): Promise<PollOutcome> {
    return await this.syncPoller.executePoll()
  }

  hasPendingPulls(): boolean {
    return this.pullQueueManager.hasPendingPulls()
  }

  async shutdown(): Promise<void> {
    await this.pullQueueManager.shutdown()
  }
}
