import {
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
  type DocumentId,
} from '@automerge/automerge-repo/slim'
import { decodeSyncMessage, encodeSyncMessage } from '@automerge/automerge/slim'
import { debounce } from 'lodash-es'

import { BaseSyncNetworkAdapter } from './BaseSyncNetworkAdapter'
import type { SyncedHeadsStore } from './stores/SyncedHeadsStore'
import { areHeadsEqual } from './utils/automerge'
import type { WorkerInternalEventHub } from './SyncEventHub'
import { BoundedQueue } from '../utils/BoundedQueue'
import { BoundedSet } from '../utils/BoundedSet'
import { RetryTimer } from '../utils/RetryTimer'
import type { LifecycleAware } from './ServiceLifecycleManager'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('VaultNetworkAdapter')

const MAX_SEEDED_DOCUMENTS = 5000
/** Outbound messages buffered while sending isn't possible */
export const MAX_OUTBOUND_QUEUE_SIZE = 1000
const MAX_RENEGOTIATION_ATTEMPTS = 3
const RENEGOTIATION_WINDOW_MS = 5000
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30000
const VAULT_PEER_ID = 'vault' as PeerId
const EMPTY_BLOOM = new Uint8Array()

type SyncHave = ReturnType<typeof decodeSyncMessage>['have'][number]

/** A sync message claiming nothing, which makes Automerge renegotiate the document from scratch */
function encodeEmptySyncMessage(): Uint8Array {
  return encodeSyncMessage({ heads: [], need: [], have: [], changes: [] })
}

/** Whether a message is a sync message carrying no changes (a negotiation or ACK) */
function isEmptySyncMessage(message: Message): boolean {
  if (message.type !== 'sync' || !(message.data instanceof Uint8Array)) {
    return false
  }
  try {
    const decoded = decodeSyncMessage(message.data)
    return !decoded.changes || decoded.changes.length === 0
  } catch (err) {
    log.warn('Failed to decode sync message', err)
    return false
  }
}
export type HeadsValidator = (documentId: DocumentId, heads: string[]) => boolean

export interface VaultNetworkAdapterOptions {
  /** Persists the last confirmed synced heads so they survive a restart */
  syncedHeadsStore?: SyncedHeadsStore
  /**
   * Whether the local document knows the given heads. Synced heads that fail it aren't claimed
   * on the vault's behalf. Without a validator, all synced heads are trusted.
   */
  headsValidator?: HeadsValidator
}

interface RenegotiationCircuitState {
  timestamps: number[]
  circuitOpenUntil?: number
  retryTimer: RetryTimer
}

export class VaultNetworkAdapter extends BaseSyncNetworkAdapter implements LifecycleAware {
  readonly lifecycleName = 'VaultNetworkAdapter'
  private account: string | null = null
  private sendEnabled = false
  private seededDocuments = new BoundedSet<DocumentId>(MAX_SEEDED_DOCUMENTS)
  private readonly outboundQueue = new BoundedQueue<Message>(MAX_OUTBOUND_QUEUE_SIZE, {
    onEvict: evicted => this.onOutboundQueueEvict(evicted),
  })

  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readyPromise: Promise<void>

  private pendingReNegotiations = new Set<DocumentId>()
  private renegotiationCircuits = new Map<DocumentId, RenegotiationCircuitState>()
  private syncedHeads = new Map<DocumentId, string[]>()
  private readonly syncedHeadsStore: SyncedHeadsStore | null
  /**
   * Whether heads changed since the last save. Only this tab's own changes count: heads loaded at
   * startup may be older than the store, and saving them would undo another tab's progress.
   */
  private hasUnsavedSyncedHeads = false
  private readonly headsValidator: HeadsValidator | null

  constructor(
    private readonly internalEventHub: WorkerInternalEventHub,
    options: VaultNetworkAdapterOptions = {},
  ) {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })
    this.syncedHeadsStore = options.syncedHeadsStore ?? null
    this.headsValidator = options.headsValidator ?? null
  }

  async onLifecycleStop(options?: { clearLocalData?: boolean }): Promise<void> {
    // disconnect() drops the heads, and a debounced save with them
    if (this.hasUnsavedSyncedHeads && !options?.clearLocalData) {
      this.saveSyncedHeadsDebounced.cancel()
      await this.persistSyncedHeads()
    }
    this.disconnect()
  }

  isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  private markReady(): void {
    if (!this.ready) {
      this.ready = true
      this.readyPromiseResolver?.()
      this.readyPromiseResolver = null
    }
  }

  /**
   * Resets readiness, so that whenReady() waits for the next markReady(). A pending
   * readiness promise is kept, so waiters from an earlier disconnect still resolve.
   */
  private resetReady(): void {
    if (this.ready || !this.readyPromiseResolver) {
      this.ready = false
      this.readyPromise = new Promise<void>(resolve => {
        this.readyPromiseResolver = resolve
      })
    }
  }

  protected override canSend(): boolean {
    return super.canSend()
      && this.connectionState === 'connected'
      && Boolean(this.account)
      && this.sendEnabled
  }

  setSendEnabled(sendEnabled: boolean): void {
    if (this.sendEnabled === sendEnabled) {
      return
    }
    this.sendEnabled = sendEnabled

    if (sendEnabled) {
      this.seededDocuments.clear()
      this.resumeSending()
    } else {
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
      this.resumeSending()
    } else {
      this.clearOutboundQueue()
    }
  }

  override connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    super.connect(peerId, peerMetadata)
    this.markReady()
    this.seededDocuments.clear()
    this.resumeSending()
  }

  /** Flushes queued messages, announces the vault peer, then replays deferred renegotiations */
  private resumeSending(): void {
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

  /** Buffers a message to send once sending is possible again */
  private enqueueOutboundMessage(message: Message): void {
    if (isEmptySyncMessage(message)) {
      // Drop empty negotiation/ACK messages during disconnect window.
      // Since the peer is not connected, reflecting an ACK is invalid.
      // When the connection is restored, Automerge will initiate a fresh
      // sync negotiation with the peer.
      return
    }

    this.outboundQueue.push(message)
  }

  private flushOutboundQueue(): void {
    if (!this.canSend()) {
      return
    }

    while (this.outboundQueue.length > 0) {
      this.processMessage(this.outboundQueue.shift()!)
    }
  }

  private onOutboundQueueEvict(evicted: Message): void {
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

  private scheduleReNegotiationRetry(
    documentId: DocumentId,
    circuit: RenegotiationCircuitState,
    delayMs: number,
  ): void {
    if (circuit.retryTimer.isPending) {
      return
    }

    circuit.retryTimer.schedule(delayMs, () => {
      if (this.isDisconnected) {
        return
      }
      this.triggerReNegotiation(documentId)
    })
  }

  triggerReNegotiation(documentId: DocumentId): boolean {
    const now = Date.now()
    let circuit = this.renegotiationCircuits.get(documentId)
    if (!circuit) {
      circuit = { timestamps: [], retryTimer: new RetryTimer() }
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

    circuit.retryTimer.cancel()

    circuit.timestamps.push(now)

    this.seededDocuments.delete(documentId)
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
    if (isEmptySyncMessage(message)) {
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
    this.resetReady()
    super.disconnect()
  }

  resetReNegotiationCircuit(documentId?: DocumentId): void {
    if (documentId) {
      this.renegotiationCircuits.get(documentId)?.retryTimer.cancel()
      this.renegotiationCircuits.delete(documentId)
    } else {
      for (const circuit of this.renegotiationCircuits.values()) {
        circuit.retryTimer.cancel()
      }
      this.renegotiationCircuits.clear()
    }
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

  private clearSyncedHeads(): void {
    this.saveSyncedHeadsDebounced.cancel()
    this.hasUnsavedSyncedHeads = false
    this.syncedHeads.clear()
  }

  private clearOutboundQueue(): void {
    this.outboundQueue.clear()
    this.pendingReNegotiations.clear()
    this.resetReNegotiationCircuit()
  }

  private connectPeer(): void {
    if (this.account && this.connectionState === 'connected' && this.sendEnabled) {
      this.dispatchPeerCandidate(VAULT_PEER_ID, {
        storageId: `vault:${this.account}` as StorageId,
        isEphemeral: false,
      })
    }
  }

  private disconnectPeer(): void {
    this.seededDocuments.clear()
    if (this.peerId) {
      this.dispatchPeerDisconnected(VAULT_PEER_ID)
    }
  }
}
