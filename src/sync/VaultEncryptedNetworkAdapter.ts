import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type Repo,
  type StorageId,
} from '@automerge/automerge-repo/slim'
import { toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { encryptSyncMessage } from './automergeSyncCrypto'
import { UnifiedSyncTransport } from './UnifiedSyncTransport'

const VAULT_PEER_ID = 'vault' as PeerId

export class VaultEncryptedNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>

  private transport = new UnifiedSyncTransport()

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })

    this.transport.on('close', () => {
      this.emit('close')
    })

    this.transport.on('message', payload => {
      this.emit('message', {
        type: 'sync',
        senderId: VAULT_PEER_ID,
        targetId: this.peerId!,
        documentId: payload.documentId,
        data: payload.message,
      })
    })
  }

  attachRepo(_: Repo): void {
    // No-op for the adapter itself, bootstrapping is handled by the application layer
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount
    this.transport.setAccount(this.account)

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

    if ((message.type !== 'sync' && message.type !== 'request') || !(message.data instanceof Uint8Array)) {
      return
    }

    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId) {
      return
    }

    const accountAtSend = this.account
    const itemId = toVaultItemIdFromAutomergeId(documentId)

    this.transport.enqueueSend(async () => {
      if (!accountAtSend || !this.connected || this.account !== accountAtSend) {
        this.emit('close')
        return
      }

      const encryptedMessage = await encryptSyncMessage(message.data as Uint8Array)
      this.transport.sendRaw('repo_sync_push', itemId, encryptedMessage)
    })
  }

  disconnect(): void {
    this.connected = false
    this.transport.clearQueue()
    this.transport.setAccount(null)
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

export { VAULT_PEER_ID }
