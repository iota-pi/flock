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

export class VaultNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>
  private sendEnabled = false
  private seededDocuments = new Set<DocumentId>()

  public onMessageToSend: ((message: Message) => void) | null = null

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })
  }

  setSendEnabled(sendEnabled: boolean): void {
    if (this.sendEnabled === sendEnabled) {
      return
    }
    this.sendEnabled = sendEnabled

    if (sendEnabled) {
      this.connectPeer()
    } else {
      this.disconnectPeer()
    }
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    if (this.account && !nextAccount) {
      this.disconnectPeer()
    }

    this.account = nextAccount

    if (this.account) {
      this.connectPeer()
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

    this.connectPeer()
  }

  send(message: Message): void {
    if (!this.connected || !this.account || message.targetId !== VAULT_PEER_ID) {
      return
    }

    if (!this.sendEnabled) {
      return
    }

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
    this.disconnectPeer()
    this.emit('close')
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

