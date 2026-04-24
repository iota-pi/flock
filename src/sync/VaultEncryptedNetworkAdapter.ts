import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type Repo,
  type StorageId,
  interpretAsDocumentId,
} from '@automerge/automerge-repo/slim'
import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { encryptSyncMessage, decryptSyncMessage } from './automergeSyncCrypto'
import { SyncTransportService } from './SyncTransportService'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'
import type { RealtimeDirectSyncPush } from '../shared/realtime'

const VAULT_PEER_ID = 'vault' as PeerId

function normalizeItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const deduped = new Set<string>()
  for (const itemId of value) {
    if (typeof itemId !== 'string' || itemId.length === 0) {
      continue
    }

    deduped.add(toVaultItemIdFromAutomergeId(itemId))
  }

  return Array.from(deduped)
}

function normalizeEventItemIds(payload: { data?: { itemIds?: unknown; deletedItemIds?: unknown } }): string[] {
  return [
    ...normalizeItemIds(payload.data?.itemIds),
    ...normalizeItemIds(payload.data?.deletedItemIds),
  ]
}

export class VaultEncryptedNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>

  private transportService = new SyncTransportService()
  private pullQueueManager = new SyncPullQueueManager()

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })

    this.transportService.on('close', () => {
      this.emit('close')
    })

    this.transportService.on('message', async (payload: unknown) => {
      if (!payload || typeof payload !== 'object') return
      const anyPayload = payload as Record<string, unknown>

      if ('action' in anyPayload) {
        if (anyPayload.action === 'sync_ping') {
          this.handleRealtimeItemHints(normalizeItemIds(anyPayload.itemIds))
          return
        }

        if (anyPayload.action === 'direct_sync_push') {
          await this.handleDirectSyncPush(anyPayload as unknown as RealtimeDirectSyncPush)
          return
        }
      }

      if ('eventType' in anyPayload && (anyPayload.eventType === 'items.updated' || anyPayload.eventType === 'items.deleted')) {
        this.handleRealtimeItemHints(normalizeEventItemIds({ data: anyPayload.data as { itemIds?: unknown; deletedItemIds?: unknown } }))
      }
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
    this.pullQueueManager.setAccount(this.account)

    if (this.account) {
      this.transportService.start(this.account)
    } else {
      this.transportService.stop()
    }

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

    this.transportService.enqueueSend(async () => {
      if (!accountAtSend || !this.connected || this.account !== accountAtSend) {
        this.emit('close')
        return
      }

      const encryptedMessage = await encryptSyncMessage(message.data as Uint8Array)
      this.transportService.sendRaw('repo_sync_push', itemId, encryptedMessage)
    })
  }

  disconnect(): void {
    this.connected = false
    this.pullQueueManager.clear()
    this.transportService.stop()
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

  private handleRealtimeItemHints(itemIds: string[]): void {
    if (!this.account) return
    void this.pullQueueManager.enqueuePull(itemIds).catch(error => {
      console.error('[VaultEncryptedNetworkAdapter] enqueuePull failed', error)
    })
  }

  private async handleDirectSyncPush(payload: RealtimeDirectSyncPush): Promise<void> {
    try {
      if (!payload.encryptedMessage?.iv || !payload.encryptedMessage?.cipher) return
      const decrypted = await decryptSyncMessage(payload.encryptedMessage)
      const itemId = toVaultItemIdFromAutomergeId(payload.itemId)
      const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

      clearManualRecoveryForItems([itemId]).catch(console.error)
      this.emit('message', {
        type: 'sync',
        senderId: VAULT_PEER_ID,
        targetId: this.peerId!,
        documentId: documentId,
        data: decrypted,
      })
    } catch (error) {
      console.error('[VaultEncryptedNetworkAdapter] Failed to decrypt direct push payload', error)
      this.handleRealtimeItemHints([payload.itemId])
    }
  }
}

export { VAULT_PEER_ID }
