import {
  type DocHandle,
  type DocHandleChangePayload,
  type DocHandleDeletePayload,
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type Repo,
  type StorageId,
} from '@automerge/automerge-repo/slim'
import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { encryptSyncMessage } from './automergeSyncCrypto'
import { SyncTransportService } from './SyncTransportService'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'

const VAULT_PEER_ID = 'vault' as PeerId

type IndexDocument = {
  itemIds?: unknown
}

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

function withIndexDocumentPriority(itemIds: string[]): string[] {
  const normalized = normalizeItemIds(itemIds)
  const deduped = new Set<string>([ACCOUNT_INDEX_DOCUMENT_ID])

  for (const itemId of normalized) {
    if (itemId !== ACCOUNT_INDEX_DOCUMENT_ID) {
      deduped.add(itemId)
    }
  }

  return Array.from(deduped)
}

export class VaultEncryptedNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>

  private repo: Repo | null = null
  private indexHandle: DocHandle<IndexDocument> | null = null
  private readonly trackedItemIds = new Set<string>()

  private transportService = new SyncTransportService()
  private pullQueueManager = new SyncPullQueueManager()

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })

    this.transportService.on('open', () => {
      this.pullTrackedItemIds()
    })

    this.transportService.on('close', () => {
      this.emit('close')
    })

    this.transportService.on('message', payload => {
      if ('action' in payload && payload.action === 'sync_ping') {
        this.handleRealtimeItemHints(normalizeItemIds(payload.itemIds))
        return
      }

      if ('eventType' in payload && (payload.eventType === 'items.updated' || payload.eventType === 'items.deleted')) {
        this.handleRealtimeItemHints(normalizeEventItemIds(payload))
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

    this.resetTrackedItemIds()
  }

  attachRepo(repo: Repo): void {
    if (this.repo === repo) {
      return
    }

    this.stopIndexObservation()
    this.repo = repo

    if (this.account) {
      this.startIndexObservation()
      this.pullTrackedItemIds()
    }
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount
    this.pullQueueManager.setAccount(this.account)
    this.resetTrackedItemIds()

    this.stopIndexObservation()
    if (this.account) {
      this.startIndexObservation()
    }

    if (!this.connected) {
      return
    }

    if (this.account) {
      this.transportService.start(this.account)
      this.emitPeerCandidate()
      this.pullTrackedItemIds()
    } else {
      this.transportService.stop()
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
      this.transportService.start(this.account)
      this.startIndexObservation()
      this.pullTrackedItemIds()
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
      this.addTrackedItemIds([itemId])
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

  private handleRealtimeItemHints(itemIds: string[]): void {
    const prioritized = withIndexDocumentPriority(itemIds)
    this.addTrackedItemIds(prioritized)
    this.enqueuePull(prioritized)
  }

  private resetTrackedItemIds(): void {
    this.trackedItemIds.clear()
    if (this.account) {
      this.trackedItemIds.add(ACCOUNT_INDEX_DOCUMENT_ID)
    }
  }

  private addTrackedItemIds(itemIds: string[]): string[] {
    const normalized = normalizeItemIds(itemIds)
    if (normalized.length === 0) {
      return []
    }

    const added: string[] = []
    for (const itemId of normalized) {
      if (this.trackedItemIds.has(itemId)) {
        continue
      }

      this.trackedItemIds.add(itemId)
      added.push(itemId)
    }

    return added
  }

  private replaceTrackedItemIdsFromIndex(itemIds: string[]): { added: string[]; removed: string[] } {
    const nextItemIds = withIndexDocumentPriority(itemIds)
    const nextSet = new Set(nextItemIds)

    const added = nextItemIds.filter(itemId => !this.trackedItemIds.has(itemId))
    const removed = Array.from(this.trackedItemIds).filter(itemId => !nextSet.has(itemId))

    this.trackedItemIds.clear()
    for (const itemId of nextItemIds) {
      this.trackedItemIds.add(itemId)
    }

    return {
      added,
      removed,
    }
  }

  private getTrackedItemIds(): string[] {
    if (this.trackedItemIds.size === 0) {
      return [ACCOUNT_INDEX_DOCUMENT_ID]
    }

    return withIndexDocumentPriority(Array.from(this.trackedItemIds))
  }

  private pullTrackedItemIds(): void {
    this.enqueuePull(this.getTrackedItemIds())
  }

  private enqueuePull(itemIds: string[]): void {
    if (!this.account || !this.connected || !this.peerId) {
      return
    }

    const prioritized = withIndexDocumentPriority(itemIds)
    this.addTrackedItemIds(prioritized)

    void this.pullQueueManager.enqueuePull(prioritized).catch(error => {
      console.error('[VaultEncryptedNetworkAdapter] enqueuePull failed', error)
    })
  }

  private startIndexObservation(): void {
    if (!this.repo || !this.account) {
      return
    }

    const handle = this.repo.findWithProgress<IndexDocument>(toAutomergeUrlFromItemId(ACCOUNT_INDEX_DOCUMENT_ID)).handle as DocHandle<IndexDocument>

    if (this.indexHandle === handle) {
      this.syncTrackedItemIdsFromIndex(handle)
      return
    }

    this.stopIndexObservation()
    this.indexHandle = handle
    handle.on('change', this.handleIndexDocumentChange)
    handle.on('delete', this.handleIndexDocumentDelete)

    this.syncTrackedItemIdsFromIndex(handle)

    if (!handle.isReady() && !handle.isUnavailable()) {
      void handle.whenReady(['ready', 'unavailable'])
        .then(() => {
          if (this.indexHandle === handle) {
            this.syncTrackedItemIdsFromIndex(handle)
          }
        })
        .catch(() => {
          // Keep adapter running; pull retries continue through realtime reconnects.
        })
    }
  }

  private stopIndexObservation(): void {
    if (!this.indexHandle) {
      return
    }

    this.indexHandle.off('change', this.handleIndexDocumentChange)
    this.indexHandle.off('delete', this.handleIndexDocumentDelete)
    this.indexHandle = null
  }

  private syncTrackedItemIdsFromIndex(handle: DocHandle<IndexDocument>): void {
    if (this.indexHandle !== handle || !this.account) {
      return
    }

    if (!handle.isReady()) {
      return
    }

    try {
      const doc = handle.doc() as IndexDocument
      const fromIndex = normalizeItemIds(doc?.itemIds)
      const { added, removed } = this.replaceTrackedItemIdsFromIndex(fromIndex)

      if (removed.length > 0) {
        this.pullQueueManager.removeKnownItemIds(removed)
      }

      if (added.length > 0) {
        this.enqueuePull(added)
      }
    } catch {
      // Ignore transient index-read failures; future changes will retrigger observation.
    }
  }

  private readonly handleIndexDocumentChange = (payload: DocHandleChangePayload<IndexDocument>): void => {
    this.syncTrackedItemIdsFromIndex(payload.handle)
  }

  private readonly handleIndexDocumentDelete = (_payload: DocHandleDeletePayload<IndexDocument>): void => {
    this.resetTrackedItemIds()
    this.pullQueueManager.clear()
    this.pullTrackedItemIds()
  }
}

export { VAULT_PEER_ID }

