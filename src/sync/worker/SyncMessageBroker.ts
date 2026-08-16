import { SyncPullQueueManager } from './SyncPullQueueManager'
import { SyncPoller, type PollOutcome } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { clearManualRecoveryForItems } from '../../api/syncHealthCoordinator'
import { persistSyncMessages } from '../shared/VaultPersistence'
import { VaultNetworkAdapter } from './VaultEncryptedNetworkAdapter'
import type { ItemId } from 'src/shared/schemas/items'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { toVaultItemIdFromAutomergeId } from './utils/automerge'
import { type Message } from '@automerge/automerge-repo/slim'

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
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private indexManager: AutomergeIndexManager,
    private pullQueueManager: SyncPullQueueManager,
  ) {
    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      if (this.account) {
        clearManualRecoveryForItems(this.account, [itemId]).catch(console.error)
      }
      this.adapter.receiveMessage(documentId, message)
      this.indexManager.addAutomergeItemIdsToIndex([itemId]).catch(console.error)
    }

    this.syncPoller = new SyncPoller(
      this.pullQueueManager,
      this.clientEventHub,
      this.internalEventHub,
      this.indexManager,
    )

    this.adapter.onMessageToSend = (msg: Message) => {
      this.handleOutgoingMessage(msg)
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

  private handleOutgoingMessage(message: Message): void {
    if (!this.sendEnabled) {
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
      let messages = this.pendingWrites.get(itemId)
      if (!messages) {
        messages = []
        this.pendingWrites.set(itemId, messages)
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
    if (writes.size > 0) {
      for (const [itemId, msgs] of writes.entries()) {
        const existing = this.pendingWrites.get(itemId) || []
        this.pendingWrites.set(itemId, [...msgs, ...existing])
      }
    }
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
