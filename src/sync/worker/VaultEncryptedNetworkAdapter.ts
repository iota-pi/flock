import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
  type DocumentId,
} from '@automerge/automerge-repo/slim'
import { decodeSyncMessage, encodeSyncMessage } from '@automerge/automerge/slim'

const VAULT_PEER_ID = 'vault' as PeerId
export const MAX_SEEDED_DOCUMENTS = 5000
export const MAX_OUTBOUND_QUEUE_SIZE = 1000

export class VaultNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>
  private sendEnabled = false
  private seededDocuments = new Set<DocumentId>()
  private outboundQueue: Message[] = []
  private pendingReNegotiations = new Set<DocumentId>()

  public onMessageToSend: ((message: Message) => void) | null = null
  public onReNegotiationTriggered: ((documentId: DocumentId) => void) | null = null

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })
  }

  private canSend(): boolean {
    return this.connected && Boolean(this.account) && this.sendEnabled
  }

  setSendEnabled(sendEnabled: boolean): void {
    if (this.sendEnabled === sendEnabled) {
      return
    }
    this.sendEnabled = sendEnabled

    if (sendEnabled) {
      if (this.canSend()) {
        this.flushOutboundQueue()
      }
      this.connectPeer()
      if (this.canSend()) {
        this.flushPendingReNegotiations()
      }
    } else {
      this.disconnectPeer()
    }
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.seededDocuments.clear()

    if (this.account && !nextAccount) {
      this.disconnectPeer()
    }

    if (this.account && this.account !== nextAccount) {
      this.clearOutboundQueue()
    }

    this.account = nextAccount

    if (this.account) {
      if (this.canSend()) {
        this.flushOutboundQueue()
      }
      this.connectPeer()
      if (this.canSend()) {
        this.flushPendingReNegotiations()
      }
    } else {
      this.clearOutboundQueue()
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

    if (this.canSend()) {
      this.flushOutboundQueue()
    }
    this.connectPeer()
    if (this.canSend()) {
      this.flushPendingReNegotiations()
    }
  }

  send(message: Message): void {
    if (message.targetId !== VAULT_PEER_ID) {
      return
    }

    if (!this.canSend()) {
      this.enqueueOutboundMessage(message)
      return
    }

    this.flushOutboundQueue()
    this.processMessage(message)
  }

  private enqueueOutboundMessage(message: Message): void {
    if (message.type === 'sync' && message.data instanceof Uint8Array) {
      try {
        const decoded = decodeSyncMessage(message.data)
        if (!decoded.changes || decoded.changes.length === 0) {
          // Drop empty negotiation/ACK messages during disconnect window.
          // Since the peer is not connected, reflecting an ACK is invalid.
          // When the connection is restored, Automerge will initiate a fresh
          // sync negotiation with the peer.
          return
        }
      } catch (err) {
        console.warn('[VaultNetworkAdapter] Failed to decode sync message while enqueuing', err)
      }
    }

    if (this.outboundQueue.length >= MAX_OUTBOUND_QUEUE_SIZE) {
      console.warn(
        `[VaultNetworkAdapter] Outbound queue exceeded max capacity (${MAX_OUTBOUND_QUEUE_SIZE}). Evicting oldest message.`
      )
      const evicted = this.outboundQueue.shift()
      if (evicted?.documentId) {
        this.triggerReNegotiation(evicted.documentId)
      }
    }
    this.outboundQueue.push(message)
  }

  triggerReNegotiation(documentId: DocumentId): void {
    this.removeSeededDocument(documentId)
    this.outboundQueue = this.outboundQueue.filter(m => m.documentId !== documentId)

    if (this.canSend() && this.peerId) {
      const emptySyncMsg = encodeSyncMessage({
        heads: [],
        need: [],
        have: [],
        changes: [],
      })
      this.receiveMessage(documentId, emptySyncMsg)
    } else {
      this.pendingReNegotiations.add(documentId)
    }

    this.onReNegotiationTriggered?.(documentId)
  }

  private flushPendingReNegotiations(): void {
    if (!this.canSend() || !this.peerId || this.pendingReNegotiations.size === 0) {
      return
    }

    const docIds = Array.from(this.pendingReNegotiations)
    this.pendingReNegotiations.clear()

    const emptySyncMsg = encodeSyncMessage({
      heads: [],
      need: [],
      have: [],
      changes: [],
    })

    for (const docId of docIds) {
      this.receiveMessage(docId, emptySyncMsg)
    }
  }

  private flushOutboundQueue(): void {
    if (!this.canSend()) {
      return
    }

    while (this.outboundQueue.length > 0) {
      const message = this.outboundQueue.shift()!
      this.processMessage(message)
    }
  }

  private processMessage(message: Message): void {
    if (message.type === 'sync' && message.data instanceof Uint8Array) {
      try {
        const decoded = decodeSyncMessage(message.data)
        if (!decoded.changes || decoded.changes.length === 0) {
          // Drop empty negotiation/ACK messages to prevent broadcast spam since the vault
          // peer is a passive relay. On the first negotiation for a document, reflect the
          // client's own heads and have state back so Automerge believes the vault is
          // already in sync. This avoids dumping the entire document history and ensures
          // only future changes are sent through the push pipeline.
          if (message.documentId && !this.seededDocuments.has(message.documentId)) {
            if (this.seededDocuments.size >= MAX_SEEDED_DOCUMENTS) {
              const oldest = this.seededDocuments.values().next().value
              if (oldest) {
                this.seededDocuments.delete(oldest)
              }
            }
            this.seededDocuments.add(message.documentId)
            const ackMsg = encodeSyncMessage({
              heads: decoded.heads || [],
              need: [],
              have: decoded.have || [],
              changes: []
            })
            queueMicrotask(() => {
              if (this.connected) {
                this.receiveMessage(message.documentId!, ackMsg)
              }
            })
          }
          return
        }
      } catch (err) {
        console.warn('[VaultNetworkAdapter] Failed to decode sync message', err)
      }
    }

    this.onMessageToSend?.(message)
  }

  receiveMessage(documentId: DocumentId, message: Uint8Array): void {
    this.emit('message', {
      type: 'sync',
      senderId: VAULT_PEER_ID,
      targetId: this.peerId!,
      documentId,
      data: message,
    })
  }

  disconnect(): void {
    this.connected = false
    this.seededDocuments.clear()
    this.pendingReNegotiations.clear()
    this.disconnectPeer()
    this.emit('close')
  }

  clearSeededDocuments(): void {
    this.seededDocuments.clear()
  }

  removeSeededDocument(documentId: DocumentId): void {
    this.seededDocuments.delete(documentId)
  }

  clearOutboundQueue(): void {
    this.outboundQueue = []
    this.pendingReNegotiations.clear()
  }

  getPendingOutboundCount(): number {
    return this.outboundQueue.length
  }

  getPendingReNegotiationCount(): number {
    return this.pendingReNegotiations.size
  }

  private connectPeer(): void {
    if (this.account && this.connected && this.sendEnabled) {
      this.emit('peer-candidate', {
        peerId: VAULT_PEER_ID,
        peerMetadata: {
          storageId: `vault:${this.account}` as StorageId,
          isEphemeral: false,
        },
      })
    }
  }

  private disconnectPeer(): void {
    if (this.peerId) {
      this.emit('peer-disconnected', { peerId: VAULT_PEER_ID })
    }
  }
}

