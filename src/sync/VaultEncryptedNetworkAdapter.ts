import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
} from '@automerge/automerge-repo/slim'
import { toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { encryptSyncMessage } from './automergeSyncCrypto'
import { SyncTransportService } from './SyncTransportService'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'

const VAULT_PEER_ID = 'vault' as PeerId

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

  private readonly knownItemIds = new Set<string>()
  private knownItemIdsSnapshot: string[] = []
  private knownItemIdsVersion = 0
  private readonly knownItemIdsListeners = new Set<KnownItemIdsListener>()

  private transportService = new SyncTransportService()
  private pullQueueManager = new SyncPullQueueManager()

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })

    this.transportService.on('open', () => {
      this.syncItemIds()
    })

    this.transportService.on('close', () => {
      this.emit('close')
    })

    this.transportService.on('message', payload => {
      if ('action' in payload && payload.action === 'sync_ping') {
        const itemIds = normalizeItemIds(payload.itemIds)
        this.registerKnownItemIds(itemIds)
        this.pullQueueManager.enqueuePull(itemIds)
        return
      }

      if ('eventType' in payload && (payload.eventType === 'items.updated' || payload.eventType === 'items.deleted')) {
        const itemIds = normalizeEventItemIds(payload)
        this.registerKnownItemIds(itemIds)
        this.pullQueueManager.enqueuePull(itemIds)
      }
    })

    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      clearManualRecoveryForItems([itemId]).catch(console.error)

      this.emit('message', {
        type: 'sync',
        senderId: VAULT_PEER_ID,
        targetId: this.peerId!,
        documentId,
        data: message,
      })
    }

    this.pullQueueManager.onKnownItemIdsDiscovered = itemIds => {
      this.registerKnownItemIds(itemIds)
    }
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount
    this.pullQueueManager.setAccount(this.account)

    this.knownItemIds.clear()
    this.notifyKnownItemIdsChanged()

    if (!this.connected) {
      return
    }

    if (this.account) {
      this.transportService.start(this.account)
      this.emitPeerCandidate()
    } else {
      this.transportService.stop()
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
    const normalized = []

    for (const rawItemId of itemIds) {
      const itemId = toVaultItemIdFromAutomergeId(rawItemId)
      if (!itemId || !this.knownItemIds.delete(itemId)) {
        continue
      }

      normalized.push(itemId)
      changed = true
    }

    this.pullQueueManager.removeKnownItemIds(normalized)

    if (changed) {
      this.notifyKnownItemIdsChanged()
    }
  }

  clearKnownItemIds(): void {
    if (this.knownItemIds.size === 0) {
      return
    }

    this.knownItemIds.clear()
    this.pullQueueManager.clear()
    this.notifyKnownItemIdsChanged()
  }

  async syncItemIds(itemIds?: string[]): Promise<void> {
    const normalized = Array.isArray(itemIds) && itemIds.length > 0
      ? normalizeItemIds(itemIds)
      : this.getKnownItemIds()

    if (normalized.length === 0) {
      return
    }

    this.registerKnownItemIds(normalized)
    await this.pullQueueManager.enqueuePull(normalized)
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
      this.transportService.start(this.account)
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
    if (itemId) {
      this.registerKnownItemIds([itemId])
    }

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

  private notifyKnownItemIdsChanged(): void {
    this.knownItemIdsVersion += 1
    this.knownItemIdsSnapshot = Array.from(this.knownItemIds)

    const itemIds = this.knownItemIdsSnapshot
    for (const listener of this.knownItemIdsListeners) {
      listener(itemIds)
    }
  }
}

export { VAULT_PEER_ID }

