import {
  interpretAsDocumentId,
  NetworkAdapter,
  type DocumentId,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
} from '@automerge/automerge-repo/slim'
import env from '../env'
import { getApiAuthToken } from '../api/runtime'
import type { RealtimeEventEnvelope } from '../shared/realtime'
import { parseRealtimePayload } from '../api/realtime/payload'
import { RealtimeWebSocketTransport } from '../api/realtime/realtimeWebSocketTransport'
import { pullSyncBatch } from '../api/vault/syncClient'
import { decryptSyncMessage, encryptSyncMessage } from './automergeSyncCrypto'
import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } from './automergeRepoIds'

const VAULT_PEER_ID = 'vault' as PeerId
const RETRY_PULL_DELAY_MS = 750

type KnownItemIdsListener = (itemIds: string[]) => void

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

function normalizeEventItemIds(payload: RealtimeEventEnvelope): string[] {
  const data = payload.data as { itemIds?: unknown; deletedItemIds?: unknown }
  return [
    ...normalizeItemIds(data?.itemIds),
    ...normalizeItemIds(data?.deletedItemIds),
  ]
}

export class VaultEncryptedNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private transport: RealtimeWebSocketTransport | null = null
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>
  private readonly cursorByItemId = new Map<string, number>()
  private sendQueue: Promise<void> = Promise.resolve()
  private sendQueueBlocked = false
  private isPulling = false
  private pullRetryTimeoutId: ReturnType<typeof setTimeout> | null = null
  private pendingPullItemIds = new Set<string>()
  private readonly knownItemIds = new Set<string>()
  private knownItemIdsSnapshot: string[] = []
  private knownItemIdsVersion = 0
  private readonly knownItemIdsListeners = new Set<KnownItemIdsListener>()

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount
    this.cursorByItemId.clear()
    this.pendingPullItemIds.clear()
    this.clearPullRetryTimeout()
    this.resetSendQueue()
    this.knownItemIds.clear()
    this.notifyKnownItemIdsChanged()

    if (!this.connected) {
      return
    }

    this.reconnectTransport()

    if (this.account) {
      this.emitPeerCandidate()
    }
  }

  isReady(): boolean {
    return this.ready
  }

  getKnownItemIds(): string[] {
    return [...this.knownItemIdsSnapshot]
  }

  getKnownItemIdsState(): { version: number; itemIds: readonly string[] } {
    return {
      version: this.knownItemIdsVersion,
      itemIds: this.knownItemIdsSnapshot,
    }
  }

  subscribeKnownItemIds(listener: KnownItemIdsListener): () => void {
    this.knownItemIdsListeners.add(listener)
    listener(this.getKnownItemIds())

    return () => {
      this.knownItemIdsListeners.delete(listener)
    }
  }

  registerKnownItemIds(itemIds: string[]): void {
    let changed = false

    for (const rawItemId of itemIds) {
      const itemId = toVaultItemIdFromAutomergeId(rawItemId)
      if (!itemId || this.knownItemIds.has(itemId)) {
        continue
      }

      this.knownItemIds.add(itemId)
      changed = true
    }

    if (changed) {
      this.notifyKnownItemIdsChanged()
    }
  }

  removeKnownItemIds(itemIds: string[]): void {
    let changed = false

    for (const rawItemId of itemIds) {
      const itemId = toVaultItemIdFromAutomergeId(rawItemId)
      if (!itemId || !this.knownItemIds.delete(itemId)) {
        continue
      }

      this.pendingPullItemIds.delete(itemId)
      this.cursorByItemId.delete(itemId)
      changed = true
    }

    if (changed) {
      this.notifyKnownItemIdsChanged()
    }
  }

  clearKnownItemIds(): void {
    if (this.knownItemIds.size === 0) {
      return
    }

    this.knownItemIds.clear()
    this.pendingPullItemIds.clear()
    this.clearPullRetryTimeout()
    this.cursorByItemId.clear()
    this.notifyKnownItemIdsChanged()
  }

  syncItemIds(itemIds?: string[]): void {
    const normalized = Array.isArray(itemIds) && itemIds.length > 0
      ? normalizeItemIds(itemIds)
      : this.getKnownItemIds()

    if (normalized.length === 0) {
      return
    }

    this.registerKnownItemIds(normalized)
    this.enqueuePull(normalized)
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.connected = true
    this.resetSendQueue()

    if (!this.ready) {
      this.ready = true
      this.readyPromiseResolver?.()
      this.readyPromiseResolver = null
    }

    if (this.account) {
      this.emitPeerCandidate()
      this.reconnectTransport()
    }
  }

  send(message: Message): void {
    if (!this.connected || !this.account || message.targetId !== VAULT_PEER_ID) {
      return
    }

    if (this.sendQueueBlocked) {
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
    const transportAtSend = this.transport
    const itemId = toVaultItemIdFromAutomergeId(documentId)

    this.sendQueue = this.sendQueue
      .then(async () => {
        if (!accountAtSend) {
          return
        }

        if (!this.connected || this.account !== accountAtSend) {
          this.emit('close')
          return
        }

        const encryptedMessage = await encryptSyncMessage(message.data as Uint8Array)

        if (!transportAtSend) {
          this.emit('close')
          return
        }

        transportAtSend.sendRaw({
          action: 'repo_sync_push',
          account: accountAtSend,
          itemId,
          encryptedMessage,
        })
      })
      .catch(error => {
        console.error('[VaultEncryptedNetworkAdapter] Failed to push sync message', error)
        this.sendQueueBlocked = true
        this.emit('close')
      })
  }

  disconnect(): void {
    this.connected = false
    this.pendingPullItemIds.clear()
    this.clearPullRetryTimeout()
    this.cursorByItemId.clear()
    this.transport?.stop()
    this.transport = null
    this.resetSendQueue()
    this.emit('close')
  }

  private reconnectTransport(): void {
    this.clearPullRetryTimeout()
    this.resetSendQueue()
    this.transport?.stop()
    this.transport = null

    if (!this.connected || !this.account) {
      return
    }

    this.transport = new RealtimeWebSocketTransport({
      account: this.account,
      endpoint: env.VAULT_WS_ENDPOINT,
      getLastEventId: () => 0,
      getToken: () => getApiAuthToken(),
      onOpen: () => {
        this.resetSendQueue()
        this.syncItemIds()
      },
      onRawMessage: rawData => {
        const payload = parseRealtimePayload(rawData)
        if (!payload) {
          return
        }

        if ('action' in payload && payload.action === 'sync_ping') {
          const itemIds = normalizeItemIds(payload.itemIds)
          this.registerKnownItemIds(itemIds)
          this.enqueuePull(itemIds)
          return
        }

        if ('eventType' in payload && (payload.eventType === 'items.updated' || payload.eventType === 'items.deleted')) {
          const itemIds = normalizeEventItemIds(payload)
          this.registerKnownItemIds(itemIds)
          this.enqueuePull(itemIds)
        }
      },
    })

    this.transport.start()
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

  private notifyKnownItemIdsChanged(): void {
    this.knownItemIdsVersion += 1
    this.knownItemIdsSnapshot = Array.from(this.knownItemIds)

    const itemIds = this.knownItemIdsSnapshot
    for (const listener of this.knownItemIdsListeners) {
      listener(itemIds)
    }
  }

  private enqueuePull(itemIds: string[]): void {
    for (const itemId of itemIds) {
      if (itemId.length === 0) {
        continue
      }

      this.pendingPullItemIds.add(itemId)
    }

    if (itemIds.length > 0) {
      this.clearPullRetryTimeout()
    }

    if (this.isPulling) {
      return
    }

    this.isPulling = true
    void this.flushPullQueue().finally(() => {
      this.isPulling = false
      if (this.pendingPullItemIds.size > 0) {
        this.schedulePullRetry()
      }
    })
  }

  private schedulePullRetry(): void {
    if (this.pullRetryTimeoutId !== null) {
      return
    }

    this.pullRetryTimeoutId = setTimeout(() => {
      this.pullRetryTimeoutId = null
      this.enqueuePull([])
    }, RETRY_PULL_DELAY_MS)
  }

  private clearPullRetryTimeout(): void {
    if (this.pullRetryTimeoutId === null) {
      return
    }

    clearTimeout(this.pullRetryTimeoutId)
    this.pullRetryTimeoutId = null
  }

  private resetSendQueue(): void {
    this.sendQueue = Promise.resolve()
    this.sendQueueBlocked = false
  }

  private async flushPullQueue(): Promise<void> {
    if (!this.account || !this.peerId) {
      this.pendingPullItemIds.clear()
      return
    }

    const queued = Array.from(this.pendingPullItemIds)
    this.pendingPullItemIds.clear()

    if (queued.length === 0) {
      return
    }

    const response = await pullSyncBatch({
      account: this.account,
      cursors: queued.map(itemId => ({
        itemId,
        cursor: this.cursorByItemId.get(itemId) || 0,
      })),
    })

    for (const result of response.results || []) {
      const itemId = toVaultItemIdFromAutomergeId(result.itemId)
      this.registerKnownItemIds([itemId])
      let highestCursor = this.cursorByItemId.get(itemId) || 0

      for (const entry of result.messages || []) {
        if (!entry?.encryptedMessage?.iv || !entry?.encryptedMessage?.cipher) {
          continue
        }

        const decrypted = await decryptSyncMessage(entry.encryptedMessage)
        const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

        this.emit('message', {
          type: 'sync',
          senderId: VAULT_PEER_ID,
          targetId: this.peerId,
          documentId: documentId as DocumentId,
          data: decrypted,
        })

        if (Number.isFinite(entry.cursor)) {
          highestCursor = Math.max(highestCursor, entry.cursor)
        }
      }

      if (Number.isFinite(result.nextCursor)) {
        highestCursor = Math.max(highestCursor, result.nextCursor)
      }

      if (highestCursor > 0) {
        this.cursorByItemId.set(itemId, highestCursor)
      }
    }
  }
}

export { VAULT_PEER_ID }
