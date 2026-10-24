import {
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
  type DocumentId,
} from '@automerge/automerge-repo/slim'
import { decodeSyncMessage, encodeSyncMessage } from '@automerge/automerge/slim'
import { debounce } from 'lodash-es'

import {
  BaseSyncNetworkAdapter,
  DEFAULT_MAX_OUTBOUND_QUEUE_SIZE,
} from './BaseSyncNetworkAdapter'
import type { SyncedHeadsStore } from './stores/SyncedHeadsStore'
import { areHeadsEqual } from './utils/automerge'
import { WorkerInternalEventHub } from './SyncEventHub'
import { BoundedSet } from '../utils/boundedCollections'
import type { LifecycleAware } from './ServiceLifecycleManager'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('VaultNetworkAdapter')

export const MAX_OUTBOUND_QUEUE_SIZE = DEFAULT_MAX_OUTBOUND_QUEUE_SIZE
const MAX_SEEDED_DOCUMENTS = 5000
export const MAX_RENEGOTIATION_ATTEMPTS = 3
export const RENEGOTIATION_WINDOW_MS = 5000
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30000
const VAULT_PEER_ID = 'vault' as PeerId
const EMPTY_BLOOM = new Uint8Array()

type SyncHave = ReturnType<typeof decodeSyncMessage>['have'][number]

/** A sync message claiming nothing, which makes Automerge renegotiate the document from scratch */
function encodeEmptySyncMessage(): Uint8Array {
  return encodeSyncMessage({ heads: [], need: [], have: [], changes: [] })
}
export type HeadsValidator = (documentId: DocumentId, heads: string[]) => boolean

interface RenegotiationCircuitState {
  timestamps: number[]
  circuitOpenUntil?: number
  retryTimer?: ReturnType<typeof setTimeout>
}

export class VaultNetworkAdapter extends BaseSyncNetworkAdapter implements LifecycleAware {
  readonly lifecycleName = 'VaultNetworkAdapter'
  private account: string | null = null
  private sendEnabled = false
  private seededDocuments = new BoundedSet<DocumentId>(MAX_SEEDED_DOCUMENTS)

  private pendingReNegotiations = new Set<DocumentId>()
  private renegotiationCircuits = new Map<DocumentId, RenegotiationCircuitState>()
  private syncedHeads = new Map<DocumentId, string[]>()
  private syncedHeadsStore: SyncedHeadsStore | null = null
  /**
   * Whether heads changed since the last save. Only this tab's own changes count: heads loaded at
   * startup may be older than the store, and saving them would undo another tab's progress.
   */
  private hasUnsavedSyncedHeads = false
  private headsValidator: HeadsValidator | null = null
  private readonly internalEventHub: WorkerInternalEventHub

  constructor(internalEventHub?: WorkerInternalEventHub) {
    super({
      maxOutboundQueueSize: MAX_OUTBOUND_QUEUE_SIZE,
    })
    this.internalEventHub = internalEventHub ?? new WorkerInternalEventHub()
  }

  public get eventHub(): WorkerInternalEventHub {
    return this.internalEventHub
  }

  async onLifecycleStop(options?: { clearLocalData?: boolean }): Promise<void> {
    // disconnect() drops the heads, and a debounced save with them
    if (this.hasUnsavedSyncedHeads && !options?.clearLocalData) {
      this.saveSyncedHeadsDebounced.cancel()
      await this.persistSyncedHeads()
    }
    this.disconnect()
  }

  protected override canSend(): boolean {
    return super.canSend() && this.connected && Boolean(this.account) && this.sendEnabled
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

  override connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    super.connect(peerId, peerMetadata)
    this.clearSeededDocuments()

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

  protected override enqueueOutboundMessage(message: Message): void {
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
        log.warn('Failed to decode sync message while enqueuing', err)
      }
    }

    super.enqueueOutboundMessage(message)
  }

  protected override onOutboundQueueEvict(evicted: Message): void {
    log.warn(
      `Outbound queue exceeded max capacity (${MAX_OUTBOUND_QUEUE_SIZE}). Evicting oldest message.`
    )
    if (evicted?.documentId) {
      const renegotiated = this.triggerReNegotiation(evicted.documentId)
      if (!renegotiated) {
        log.warn(
          `Renegotiation for evicted document ${evicted.documentId} deferred due to active circuit breaker.`
        )
      }
    }
  }

  protected override processOutboundMessage(message: Message): void {
    this.processMessage(message)
  }

  private scheduleReNegotiationRetry(
    documentId: DocumentId,
    circuit: RenegotiationCircuitState,
    delayMs: number,
  ): void {
    if (circuit.retryTimer) {
      return
    }

    const timer = setTimeout(() => {
      if (circuit.retryTimer === timer) {
        circuit.retryTimer = undefined
      }
      if (this.isDisconnected) {
        return
      }
      this.triggerReNegotiation(documentId)
    }, Math.max(0, delayMs))

    circuit.retryTimer = timer
  }

  triggerReNegotiation(documentId: DocumentId): boolean {
    const now = Date.now()
    let circuit = this.renegotiationCircuits.get(documentId)
    if (!circuit) {
      circuit = { timestamps: [] }
      this.renegotiationCircuits.set(documentId, circuit)
    }

    if (circuit.circuitOpenUntil) {
      if (now < circuit.circuitOpenUntil) {
        log.warn(
          `Renegotiation circuit breaker is OPEN for document ${documentId}. Skipping renegotiation.`
        )
        this.scheduleReNegotiationRetry(documentId, circuit, circuit.circuitOpenUntil - now)
        return false
      }
      circuit.circuitOpenUntil = undefined
    }

    circuit.timestamps = circuit.timestamps.filter(ts => now - ts < RENEGOTIATION_WINDOW_MS)

    if (circuit.timestamps.length >= MAX_RENEGOTIATION_ATTEMPTS) {
      circuit.circuitOpenUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS
      log.warn(
        `Renegotiation limit reached for document ${documentId} (${circuit.timestamps.length} attempts in ${RENEGOTIATION_WINDOW_MS}ms). Tripping circuit breaker for ${CIRCUIT_BREAKER_COOLDOWN_MS}ms.`
      )
      this.scheduleReNegotiationRetry(documentId, circuit, CIRCUIT_BREAKER_COOLDOWN_MS)
      return false
    }

    if (circuit.retryTimer) {
      clearTimeout(circuit.retryTimer)
      circuit.retryTimer = undefined
    }

    circuit.timestamps.push(now)

    this.removeSeededDocument(documentId)
    this.outboundQueue.filterInPlace(m => m.documentId !== documentId)

    if (this.canSend() && this.peerId) {
      this.receiveMessage(documentId, encodeEmptySyncMessage())
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

    const emptySyncMsg = encodeEmptySyncMessage()
    for (const docId of docIds) {
      this.receiveMessage(docId, emptySyncMsg)
    }
  }

  private processMessage(message: Message): void {
    if (message.type === 'sync' && message.data instanceof Uint8Array) {
      try {
        const decoded = decodeSyncMessage(message.data)
        if (!decoded.changes || decoded.changes.length === 0) {
          // Drop empty negotiation/ACK messages to prevent broadcast spam since the vault
          // peer is a passive relay.
          // On initial negotiation for a document, reply on behalf of the vault declaring
          // that it holds everything up to the last confirmed synced heads. Automerge then
          // emits every change after those heads (including any unpushed offline edits),
          // and keeps emitting subsequent local changes as they are made.
          if (message.documentId && !this.seededDocuments.has(message.documentId)) {
            this.seededDocuments.add(message.documentId)

            const ackMsg = encodeSyncMessage({
              ...this.buildVaultState(message.documentId),
              need: [],
              changes: [],
            })
            queueMicrotask(() => {
              if (this.canSend() && this.peerId) {
                this.receiveMessage(message.documentId!, ackMsg)
              } else if (message.documentId) {
                this.seededDocuments.delete(message.documentId)
              }
            })
          }
          return
        }
      } catch (err) {
        log.warn('Failed to decode sync message', err)
      }
    }

    this.internalEventHub.emit({ type: 'messageToSend', message })
  }

  /**
   * Describes the vault's sync state for a document: everything up to the last confirmed
   * synced heads. Synced heads that are unknown to the local document (e.g. stale persisted
   * heads) would make Automerge reply with a change-less reset message, so they fall back to
   * an empty lastSync, which makes Automerge send the full history.
   */
  private buildVaultState(documentId: DocumentId): { heads: string[]; have: SyncHave[] } {
    const synced = this.syncedHeads.get(documentId)
    const isKnown = Boolean(
      synced
      && synced.length > 0
      && (!this.headsValidator || this.headsValidator(documentId, synced))
    )
    const lastSync = isKnown ? synced! : []
    return {
      heads: lastSync,
      have: [{ lastSync, bloom: EMPTY_BLOOM }],
    }
  }

  /**
   * Delivers a sync message pulled from the server. Pulled messages were generated by other
   * devices (or this one), so their `have`/`need` describe that device's sync state, not the
   * vault's. Passing them through verbatim can leave the local sync state referencing changes
   * this device has never seen, which stalls all further outbound changes for the document.
   * Only the changes and heads are kept; the vault state is restated from the synced heads.
   */
  receiveServerMessage(documentId: DocumentId, message: Uint8Array): void {
    let sanitized = message
    try {
      const decoded = decodeSyncMessage(message)
      sanitized = encodeSyncMessage({
        ...this.buildVaultState(documentId),
        heads: decoded.heads,
        need: [],
        changes: decoded.changes,
      })
    } catch (err) {
      log.warn('Failed to decode server sync message, delivering as-is', err)
    }
    this.receiveMessage(documentId, sanitized)
  }

  receiveMessage(documentId: DocumentId, message: Uint8Array): void {
    if (!this.peerId) {
      return
    }
    this.dispatchMessage({
      type: 'sync',
      senderId: VAULT_PEER_ID,
      targetId: this.peerId,
      documentId,
      data: message,
    })
  }

  override disconnect(): void {
    this.seededDocuments.clear()
    this.pendingReNegotiations.clear()
    this.clearSyncedHeads()
    this.resetReNegotiationCircuit()
    this.disconnectPeer()
    super.disconnect()
  }

  isReNegotiationCircuitOpen(documentId: DocumentId): boolean {
    const circuit = this.renegotiationCircuits.get(documentId)
    if (!circuit?.circuitOpenUntil) return false
    return Date.now() < circuit.circuitOpenUntil
  }

  hasReNegotiationRetryScheduled(documentId: DocumentId): boolean {
    return Boolean(this.renegotiationCircuits.get(documentId)?.retryTimer)
  }

  resetReNegotiationCircuit(documentId?: DocumentId): void {
    if (documentId) {
      const circuit = this.renegotiationCircuits.get(documentId)
      if (circuit?.retryTimer) {
        clearTimeout(circuit.retryTimer)
        circuit.retryTimer = undefined
      }
      this.renegotiationCircuits.delete(documentId)
    } else {
      for (const circuit of this.renegotiationCircuits.values()) {
        if (circuit.retryTimer) {
          clearTimeout(circuit.retryTimer)
          circuit.retryTimer = undefined
        }
      }
      this.renegotiationCircuits.clear()
    }
  }

  setHeadsValidator(validator: HeadsValidator | null): void {
    this.headsValidator = validator
  }

  setSyncedHeadsStore(store: SyncedHeadsStore | null): void {
    this.syncedHeadsStore = store
  }

  loadSyncedHeads(entries: [DocumentId, string[]][]): void {
    for (const [docId, heads] of entries) {
      this.syncedHeads.set(docId, heads)
    }
  }

  setSyncedHeads(documentId: DocumentId, heads: string[]): void {
    const existing = this.syncedHeads.get(documentId)
    if (existing && areHeadsEqual(existing, heads)) {
      return
    }
    this.syncedHeads.set(documentId, heads)
    this.hasUnsavedSyncedHeads = true
    this.saveSyncedHeadsDebounced()
  }

  private readonly saveSyncedHeadsDebounced = debounce(() => {
    fireAndForget(this.persistSyncedHeads(), 'VaultNetworkAdapter:persistSyncedHeads')
  }, 1000)

  async persistSyncedHeads(): Promise<void> {
    if (!this.syncedHeadsStore) return
    const entries = Array.from(this.syncedHeads.entries())
    this.hasUnsavedSyncedHeads = false
    try {
      await this.syncedHeadsStore.saveSyncedHeads(entries)
    } catch (err) {
      this.hasUnsavedSyncedHeads = true
      log.error('Failed to persist synced heads', err)
    }
  }

  clearSyncedHeads(): void {
    this.saveSyncedHeadsDebounced.cancel()
    this.hasUnsavedSyncedHeads = false
    this.syncedHeads.clear()
  }

  clearSeededDocuments(): void {
    this.seededDocuments.clear()
  }

  removeSeededDocument(documentId: DocumentId): void {
    this.seededDocuments.delete(documentId)
  }

  override clearOutboundQueue(): void {
    super.clearOutboundQueue()
    this.pendingReNegotiations.clear()
    this.resetReNegotiationCircuit()
  }

  getPendingReNegotiationCount(): number {
    return this.pendingReNegotiations.size
  }

  private connectPeer(): void {
    if (this.account && this.connected && this.sendEnabled) {
      this.dispatchPeerCandidate(VAULT_PEER_ID, {
        storageId: `vault:${this.account}` as StorageId,
        isEphemeral: false,
      })
    }
  }

  private disconnectPeer(): void {
    this.clearSeededDocuments()
    if (this.peerId) {
      this.dispatchPeerDisconnected(VAULT_PEER_ID)
    }
  }
}
