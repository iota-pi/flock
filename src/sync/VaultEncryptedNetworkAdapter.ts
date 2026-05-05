import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type Repo,
  type StorageId,
  type DocumentId,
  interpretAsDocumentId,
} from '@automerge/automerge-repo/slim'
import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { encryptSyncMessage, decryptSyncMessage } from './automergeSyncCrypto'
import { SyncTransportService } from './SyncTransportService'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'
import type { RealtimeDirectSyncPush } from '../shared/realtime'
import { readItemSchema, errorItemSchema } from '../shared/schemas/items'

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

  private syncBatchTimeout: number | null = null
  private syncBatch: Map<string, Uint8Array[]> = new Map()

  private heartbeatInterval: number | null = null
  private lastMessageTime: number = Date.now()
  private reconnectAttempts: number = 0
  private reconnectTimeout: number | null = null

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })

    this.transportService.on('open', () => {
      this.reconnectAttempts = 0
    })

    this.transportService.on('close', () => {
      this.emit('close')
      if (this.reconnectTimeout) {
        self.clearTimeout(this.reconnectTimeout)
      }
      if (!this.account) return

      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
      this.reconnectAttempts += 1
      this.reconnectTimeout = self.setTimeout(() => {
        if (this.account) {
          this.transportService.start(this.account)
          this.startHeartbeat()
        }
      }, delay)
    })

    this.transportService.on('message', async (payload: unknown) => {
      this.lastMessageTime = Date.now()
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

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount
    this.pullQueueManager.setAccount(this.account)

    if (this.account) {
      this.transportService.start(this.account)
      this.startHeartbeat()
    } else {
      if (this.reconnectTimeout) {
        self.clearTimeout(this.reconnectTimeout)
        this.reconnectTimeout = null
      }
      this.reconnectAttempts = 0
      this.transportService.stop()
      this.stopHeartbeat()
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
    console.debug('[VaultEncryptedNetworkAdapter] send called with message:', message, this.connected, this.account)
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

    const itemId = toVaultItemIdFromAutomergeId(documentId)

    let messages = this.syncBatch.get(itemId)
    if (!messages) {
      messages = []
      this.syncBatch.set(itemId, messages)
    }
    messages.push(message.data as Uint8Array)

    if (this.syncBatchTimeout === null) {
      this.syncBatchTimeout = self.setTimeout(() => this.flushSyncBatch(), 0)
    }
  }

  private flushSyncBatch(): void {
    this.syncBatchTimeout = null
    const accountAtSend = this.account

    for (const [itemId, messages] of this.syncBatch.entries()) {
      this.transportService.enqueueSend(async () => {
        if (!accountAtSend || !this.connected || this.account !== accountAtSend) {
          this.emit('close')
          return
        }

        let totalLength = 0
        for (const m of messages) {
          totalLength += 4 + m.length
        }
        const combined = new Uint8Array(totalLength)
        const view = new DataView(combined.buffer)
        let offset = 0
        for (const m of messages) {
          view.setUint32(offset, m.length, false)
          offset += 4
          combined.set(m, offset)
          offset += m.length
        }

        const encryptedMessage = await encryptSyncMessage(combined)
        const envelope = {
          version: '1.0',
          ...encryptedMessage,
        }
        this.transportService.sendRaw('repo_sync_push', itemId, envelope)
      })
    }
    this.syncBatch.clear()
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

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.lastMessageTime = Date.now()
    this.heartbeatInterval = self.setInterval(() => {
      if (!this.account || !this.connected) return

      if (Date.now() - this.lastMessageTime > 45000) {
        console.warn('[VaultEncryptedNetworkAdapter] Heartbeat timeout. Closing transport.')
        this.emit('close')
        return
      }

      this.transportService.sendRaw('sync_ping', '', {})
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      self.clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
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

      const isBatched = 'version' in payload.encryptedMessage && (payload.encryptedMessage as Record<string, unknown>).version === '1.0'

      if (isBatched) {
        let offset = 0
        const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength)
        while (offset < decrypted.byteLength) {
          const length = view.getUint32(offset, false)
          offset += 4
          const msg = new Uint8Array(decrypted.buffer, decrypted.byteOffset + offset, length)
          offset += length

          this.validateAndEmit(msg, documentId)
        }
      } else {
        this.validateAndEmit(decrypted, documentId)
      }
    } catch (error) {
      console.error('[VaultEncryptedNetworkAdapter] Failed to decrypt direct push payload', error)
      this.handleRealtimeItemHints([payload.itemId])
    }
  }

  private validateAndEmit(data: Uint8Array, documentId: DocumentId): void {
    let parsedObj: unknown = data
    try {
      parsedObj = JSON.parse(new TextDecoder().decode(data))
    } catch {
      // Fallback for raw binary payloads
    }

    if (parsedObj && typeof parsedObj === 'object' && !(parsedObj instanceof Uint8Array)) {
      const isValid = readItemSchema.safeParse(parsedObj).success || errorItemSchema.safeParse(parsedObj).success
      if (!isValid) {
        console.warn('[VaultEncryptedNetworkAdapter] Validation failed. Dropping poison document.')
        return
      }
    }

    this.emit('message', {
      type: 'sync',
      senderId: VAULT_PEER_ID,
      targetId: this.peerId!,
      documentId: documentId,
      data: data,
    })
  }
}

export { VAULT_PEER_ID }
