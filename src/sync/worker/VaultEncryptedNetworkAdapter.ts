import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
  type DocumentId,
} from '@automerge/automerge-repo/slim'
import { decodeSyncMessage, encodeSyncMessage } from '@automerge/automerge/slim'
import { debounce } from 'lodash-es'

import type { SyncedHeadsStore } from './stores/SyncedHeadsStore'
import { areHeadsEqual } from './utils/automerge'
import { WorkerInternalEventHub } from './SyncEventHub'
import { BoundedQueue, BoundedSet } from '../utils/boundedCollections'

const VAULT_PEER_ID = 'vault' as PeerId
export const MAX_SEEDED_DOCUMENTS = 5000
export const MAX_OUTBOUND_QUEUE_SIZE = 1000
export const MAX_RENEGOTIATION_ATTEMPTS = 3
export const RENEGOTIATION_WINDOW_MS = 5000
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30000

interface RenegotiationCircuitState {
  timestamps: number[]
  circuitOpenUntil?: number
}

export class VaultNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>
  private sendEnabled = false
  private seededDocuments = new BoundedSet<DocumentId>(MAX_SEEDED_DOCUMENTS)
  private outboundQueue = new BoundedQueue<Message>(MAX_OUTBOUND_QUEUE_SIZE, {
    onEvict: evicted => {
      console.warn(
        `[VaultNetworkAdapter] Outbound queue exceeded max capacity (${MAX_OUTBOUND_QUEUE_SIZE}). Evicting oldest message.`
      )
      if (evicted?.documentId) {
        this.triggerReNegotiation(evicted.documentId)
      }
    },
  })

  private pendingReNegotiations = new Set<DocumentId>()
  private renegotiationCircuits = new Map<DocumentId, RenegotiationCircuitState>()
  private syncedHeads = new Map<DocumentId, string[]>()
  private syncedHeadsStore: SyncedHeadsStore | null = null
  private internalEventHub: WorkerInternalEventHub

  constructor(internalEventHub?: WorkerInternalEventHub) {
    super()
    this.internalEventHub = internalEventHub ?? new WorkerInternalEventHub()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })
  }

  public get eventHub(): WorkerInternalEventHub {
    return this.internalEventHub
  }

  setInternalEventHub(hub: WorkerInternalEventHub): void {
    this.internalEventHub = hub
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
      this.clearSeededDocuments()
      if (this.canSend()) {
        this.flushOutboundQueue()
      }
      this.connectPeer()
      if (this.canSend()) {
        this.flushPendingReNegotiations()
      }
    } else {
      this.clearSeededDocuments()
      this.disconnectPeer()
    }
  }

  setAccount(account: string | null): void {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    if (this.account) {
      this.seededDocuments.clear()
      this.clearSyncedHeads()

      if (!nextAccount) {
        this.disconnectPeer()
      }

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
    this.clearSeededDocuments()

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

    this.outboundQueue.push(message)
  }

  triggerReNegotiation(documentId: DocumentId): boolean {
    const now = Date.now()
    let circuit = this.renegotiationCircuits.get(documentId)
    if (!circuit) {
      circuit = { timestamps: [] }
      this.renegotiationCircuits.set(documentId, circuit)
    }

    if (circuit.circuitOpenUntil && now < circuit.circuitOpenUntil) {
      console.warn(
        `[VaultNetworkAdapter] Renegotiation circuit breaker is OPEN for document ${documentId}. Skipping renegotiation.`
      )
      return false
    }

    circuit.timestamps = circuit.timestamps.filter(ts => now - ts < RENEGOTIATION_WINDOW_MS)

    if (circuit.timestamps.length >= MAX_RENEGOTIATION_ATTEMPTS) {
      circuit.circuitOpenUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS
      console.warn(
        `[VaultNetworkAdapter] Renegotiation limit reached for document ${documentId} (${circuit.timestamps.length} attempts in ${RENEGOTIATION_WINDOW_MS}ms). Tripping circuit breaker for ${CIRCUIT_BREAKER_COOLDOWN_MS}ms.`
      )
      return false
    }

    circuit.timestamps.push(now)

    this.removeSeededDocument(documentId)
    this.outboundQueue.filterInPlace(m => m.documentId !== documentId)

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

    this.internalEventHub.emit({ type: 'renegotiationTriggered', documentId })
    return true
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
          // peer is a passive relay.
          // On initial negotiation for a document, check if we have confirmed synced heads.
          // If the document is already in sync with the vault peer, acknowledge with empty need
          // to prevent dumping entire history.
          // If the document has unpushed offline changes (or is newly created), acknowledge with
          // the last confirmed synced heads and request the missing local heads (need: decoded.heads),
          // prompting Automerge to emit the delta changes.
          if (message.documentId && !this.seededDocuments.has(message.documentId)) {
            this.seededDocuments.add(message.documentId)

            const synced = this.syncedHeads.get(message.documentId)
            const isFullySynced = Boolean(synced && areHeadsEqual(synced, decoded.heads))

            const ackMsg = encodeSyncMessage({
              heads: synced || [],
              need: isFullySynced ? [] : (decoded.heads || []),
              have: isFullySynced ? (decoded.have || []) : [],
              changes: [],
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

    this.internalEventHub.emit({ type: 'messageToSend', message })
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
    this.clearSyncedHeads()
    this.resetReNegotiationCircuit()
    this.disconnectPeer()
    this.emit('close')
  }

  isReNegotiationCircuitOpen(documentId: DocumentId): boolean {
    const circuit = this.renegotiationCircuits.get(documentId)
    if (!circuit?.circuitOpenUntil) return false
    return Date.now() < circuit.circuitOpenUntil
  }

  resetReNegotiationCircuit(documentId?: DocumentId): void {
    if (documentId) {
      this.renegotiationCircuits.delete(documentId)
    } else {
      this.renegotiationCircuits.clear()
    }
  }

  setSyncedHeadsStore(store: SyncedHeadsStore | null): void {
    this.syncedHeadsStore = store
  }

  loadSyncedHeads(entries: [DocumentId, string[]][]): void {
    for (const [docId, heads] of entries) {
      this.syncedHeads.set(docId, heads)
    }
  }

  getSyncedHeads(documentId: DocumentId): string[] | undefined {
    return this.syncedHeads.get(documentId)
  }

  setSyncedHeads(documentId: DocumentId, heads: string[]): void {
    const existing = this.syncedHeads.get(documentId)
    if (existing && areHeadsEqual(existing, heads)) {
      return
    }
    this.syncedHeads.set(documentId, heads)
    this.saveSyncedHeadsDebounced()
  }

  private readonly saveSyncedHeadsDebounced = debounce(() => {
    void this.persistSyncedHeads()
  }, 1000)

  async persistSyncedHeads(): Promise<void> {
    if (!this.syncedHeadsStore) return
    const entries = Array.from(this.syncedHeads.entries())
    try {
      await this.syncedHeadsStore.saveSyncedHeads(entries)
    } catch (err) {
      console.error('[VaultNetworkAdapter] Failed to persist synced heads', err)
    }
  }

  clearSyncedHeads(): void {
    this.saveSyncedHeadsDebounced.cancel()
    this.syncedHeads.clear()
  }

  clearSeededDocuments(): void {
    this.seededDocuments.clear()
  }

  removeSeededDocument(documentId: DocumentId): void {
    this.seededDocuments.delete(documentId)
  }

  clearOutboundQueue(): void {
    this.outboundQueue.clear()
    this.pendingReNegotiations.clear()
    this.resetReNegotiationCircuit()
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
    this.clearSeededDocuments()
    if (this.peerId) {
      this.emit('peer-disconnected', { peerId: VAULT_PEER_ID })
    }
  }
}

