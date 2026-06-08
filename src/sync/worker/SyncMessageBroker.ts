import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncPoller, type PollOutcome } from './SyncPoller'
import { SyncEventHub } from './SyncEventHub'
import { clearManualRecoveryForItems } from '../../api/syncHealthCoordinator'
import { persistSyncMessages } from '../shared/VaultPersistence'
import { VaultNetworkAdapter, type RawSyncMessage } from './VaultEncryptedNetworkAdapter'
import type { ItemId } from 'src/shared/schemas/items'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'

export class SyncMessageBroker {
  private account: string | null = null
  private isOnline = true
  private sendEnabled = false

  private syncPoller: SyncPoller

  private pendingWrites: Map<string, Uint8Array[]> = new Map()
  private persistTimeoutId: ReturnType<typeof setTimeout> | null = null

  public onFlushNeeded: (() => void) | null = null

  constructor(
    private adapter: VaultNetworkAdapter,
    private eventHub: SyncEventHub,
    private indexManager: AutomergeIndexManager,
    private pullQueueManager: SyncPullQueueManager,
  ) {
    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      if (this.account) {
        clearManualRecoveryForItems(this.account, [itemId]).catch(console.error)
      }
      this.adapter.receiveMessage(itemId, message)
    }

    this.syncPoller = new SyncPoller(
      this.pullQueueManager,
      this.eventHub,
      this.indexManager,
    )

    this.adapter.onMessageSent = (rawMsg: RawSyncMessage) => {
      this.handleOutgoingMessage(rawMsg)
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

    if (this.persistTimeoutId) {
      clearTimeout(this.persistTimeoutId)
      this.persistTimeoutId = null
    }
    await this.persistPendingWrites()

    this.account = nextAccount
    await this.pullQueueManager.setAccount(this.account)
    this.syncPoller.setAccount(this.account)
  }

  setOnlineState(isOnline: boolean): void {
    if (this.isOnline === isOnline) {
      return
    }

    this.isOnline = isOnline
    this.syncPoller.setOnlineState(isOnline)
  }

  private handleOutgoingMessage(message: RawSyncMessage): void {
    if (!this.sendEnabled) {
      return
    }

    if (message.type === 'request') {
      this.pullQueueManager.addPendingItem(message.itemId)
      this.flush()
    } else if (message.type === 'sync') {
      let messages = this.pendingWrites.get(message.itemId)
      if (!messages) {
        messages = []
        this.pendingWrites.set(message.itemId, messages)
      }
      messages.push(message.data)
      this.flush()
    }
  }

  private async persistPendingWrites(): Promise<void> {
    if (this.pendingWrites.size === 0 || !this.account) {
      return
    }
    const writes = new Map(this.pendingWrites)
    this.pendingWrites.clear()
    await persistSyncMessages(this.account, writes)
  }

  flush(): void {
    if (this.persistTimeoutId === null) {
      this.persistTimeoutId = setTimeout(
        () => void this.flushPersistAndSignal(),
        0
      )
    }
  }

  private async flushPersistAndSignal(): Promise<void> {
    this.persistTimeoutId = null
    await this.persistPendingWrites()
    this.onFlushNeeded?.()
  }

  queuePendingPullItems(itemIds: ItemId[]): void {
    if (!itemIds || itemIds.length === 0) return
    for (const itemId of itemIds) {
      this.pullQueueManager.addPendingItem(itemId)
    }
    this.flush()
  }

  exportCursors(): [ItemId, number][] {
    return this.pullQueueManager.exportCursors()
  }

  async importCursors(cursors: [ItemId, number][]): Promise<void> {
    await this.pullQueueManager.importCursors(cursors)
  }

  async executePoll(): Promise<PollOutcome> {
    return await this.syncPoller.executePoll()
  }

  hasPendingPulls(): boolean {
    return this.pullQueueManager.hasPendingPulls()
  }

  async shutdown(): Promise<void> {
    if (this.persistTimeoutId) {
      clearTimeout(this.persistTimeoutId)
      this.persistTimeoutId = null
    }
    await this.pullQueueManager.shutdown()
    await this.persistPendingWrites()
  }
}
