import {
  NetworkAdapter,
  interpretAsDocumentId,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
} from '@automerge/automerge-repo/slim'

import { toVaultItemIdFromAutomergeId, toAutomergeUrlFromItemId } from './automergeRepoIds'
import type { ItemId } from 'src/shared/schemas/items'

const VAULT_PEER_ID = 'vault' as PeerId

export type RawSyncMessage =
  | { type: 'request'; itemId: ItemId }
  | { type: 'sync'; itemId: ItemId; data: Uint8Array }

export class VaultNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>
  private sendEnabled = false

  public onMessageSent: ((message: RawSyncMessage) => void) | null = null

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })
  }

  setSendEnabled(sendEnabled: boolean): void {
    this.sendEnabled = sendEnabled
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount

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
  }

  send(message: Message): void {
    if (!this.connected || !this.account || message.targetId !== VAULT_PEER_ID) {
      return
    }

    if (!this.sendEnabled) {
      return
    }

    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId) {
      return
    }

    const itemId = toVaultItemIdFromAutomergeId(documentId)

    if (message.type === 'request') {
      this.onMessageSent?.({
        type: 'request',
        itemId,
      })
    } else if (message.type === 'sync' && message.data instanceof Uint8Array) {
      this.onMessageSent?.({
        type: 'sync',
        itemId,
        data: message.data,
      })
    }
  }

  receiveMessage(itemId: ItemId, message: Uint8Array): void {
    const url = toAutomergeUrlFromItemId(itemId)
    const documentId = interpretAsDocumentId(url)
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
