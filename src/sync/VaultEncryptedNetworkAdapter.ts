import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
} from '@automerge/automerge-repo/slim'

import { toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'
import {
  persistSyncMessages,
} from './VaultPersistence'
import { SyncPoller, type PollOutcome } from './SyncPoller'

const VAULT_PEER_ID = 'vault' as PeerId

export class VaultEncryptedNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private isOnline = true
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>
  private isLeader = false

  private pullQueueManager = new SyncPullQueueManager()
  private syncPoller: SyncPoller

  private pendingWrites: Map<string, Uint8Array[]> = new Map()

  onStartRequest: (() => void) | null = null
  onFinishRequest: (() => void) | null = null
  onSnapshotNeeded: ((cursor: number, requestedAt: number) => void) | null = null
  onAuthFailure: ((message: string) => void) | null = null
  onPollResult: ((outcome: PollOutcome) => void) | null = null

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })

    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      clearManualRecoveryForItems([itemId]).catch(console.error)
      this.emit('message', {
        type: 'sync',
        senderId: VAULT_PEER_ID,
        targetId: this.peerId!,
        documentId: documentId,
        data: message,
      })
    }

    this.syncPoller = new SyncPoller(
      this.pullQueueManager,
      {
        onStartRequest: () => this.onStartRequest?.(),
        onFinishRequest: () => this.onFinishRequest?.(),
        onSnapshotNeeded: (cursor, requestedAt) => this.onSnapshotNeeded?.(cursor, requestedAt),
        onAuthFailure: (msg) => this.onAuthFailure?.(msg),
        onPollResult: (outcome) => this.onPollResult?.(outcome),
      },
      () => this.persistPendingWrites()
    )
  }

  setLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader
    this.syncPoller.setLeader(isLeader)
  }

  async setAccount(account: string | null): Promise<void> {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    await this.persistPendingWrites()

    this.account = nextAccount
    await this.pullQueueManager.setAccount(this.account)
    this.syncPoller.setAccount(this.account)

    if (!this.connected) {
      return
    }

    if (this.account) {
      this.emitPeerCandidate()
    }
  }

  isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.connected = true

    if (!this.ready) {
      this.ready = true
      this.readyPromiseResolver?.()
      this.readyPromiseResolver = null
    }

    if (this.account) {
      this.emitPeerCandidate()
    }

    if (this.account && this.isOnline && this.isLeader) {
      this.syncPoller.startPolling(true)
    }
  }

  setOnlineState(isOnline: boolean): void {
    if (this.isOnline === isOnline) {
      return
    }

    this.isOnline = isOnline
    this.syncPoller.setOnlineState(isOnline)

    if (!this.connected) {
      return
    }

    if (!isOnline) {
      return
    }

    if (this.account && this.isLeader) {
      this.syncPoller.startPolling(true)
    }
  }

  send(message: Message): void {
    if (!this.connected || !this.account || message.targetId !== VAULT_PEER_ID) {
      return
    }

    if (!this.isLeader) {
      return
    }

    if (message.type === 'request') {
      this.handleRequestMessage(message)
    } else if (message.type === 'sync' && message.data instanceof Uint8Array) {
      this.handleSyncMessage(message)
    }
  }

  private handleRequestMessage(message: Message): void {
    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId) {
      return
    }

    const itemId = toVaultItemIdFromAutomergeId(documentId)
    this.pullQueueManager.addPendingItem(itemId)

    this.flush()
  }

  private handleSyncMessage(message: Message): void {
    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId || !(message.data instanceof Uint8Array)) {
      return
    }

    const itemId = toVaultItemIdFromAutomergeId(documentId)

    let messages = this.pendingWrites.get(itemId)
    if (!messages) {
      messages = []
      this.pendingWrites.set(itemId, messages)
    }
    messages.push(message.data as Uint8Array)

    this.flush()
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
    this.syncPoller.flush()
  }

  queuePendingPullItems(itemIds: string[]): void {
    if (!itemIds || itemIds.length === 0) return
    for (const itemId of itemIds) {
      this.pullQueueManager.addPendingItem(itemId)
    }
    this.flush()
  }

  // Exposed for testing
  async executePoll(): Promise<PollOutcome> {
    (this.syncPoller as any).isOnline = this.isOnline;
    (this.syncPoller as any).isLeader = this.isLeader;
    (this.syncPoller as any).account = this.account;
    return (this.syncPoller as any).executePoll()
  }

  exportCursors(): [string, number][] {
    return this.pullQueueManager.exportCursors()
  }

  async importCursors(cursors: [string, number][]): Promise<void> {
    await this.pullQueueManager.importCursors(cursors)
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.syncPoller.stopPolling()
    await this.pullQueueManager.shutdown()
    await this.persistPendingWrites()
    this.emit('close')
  }

  private emitPeerCandidate(): void {
    this.emit('peer-candidate', {
      peerId: VAULT_PEER_ID,
      peerMetadata: {
        storageId: `vault:${this.account}` as StorageId,
        isEphemeral: false,
      },
    })
  }
}
