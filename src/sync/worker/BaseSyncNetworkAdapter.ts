import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo/slim'
import { BoundedQueue } from '../utils/boundedCollections'

export const DEFAULT_MAX_OUTBOUND_QUEUE_SIZE = 1000

export interface BaseSyncNetworkAdapterOptions {
  /** Maximum number of outbound messages to buffer when disconnected or not ready. Default: 1000 */
  maxOutboundQueueSize?: number
  /** Callback when the outbound queue exceeds capacity and drops/evicts a message */
  onOutboundQueueEvict?: (evicted: Message) => void
}

/**
 * BaseSyncNetworkAdapter provides a consolidated connection state machine,
 * disconnect buffering and replay queue, and Automerge Repo adapter event
 * dispatching for Flock network adapters.
 */
export abstract class BaseSyncNetworkAdapter extends NetworkAdapter {
  protected connected = false
  protected isDisconnected = false
  protected ready = false
  protected isPaused = false

  protected readyPromiseResolver: (() => void) | null = null
  protected readonly readyPromise: Promise<void>
  protected outboundQueue: BoundedQueue<Message>

  constructor(options?: BaseSyncNetworkAdapterOptions) {
    super()
    const maxQueue = options?.maxOutboundQueueSize ?? DEFAULT_MAX_OUTBOUND_QUEUE_SIZE
    this.outboundQueue = new BoundedQueue<Message>(maxQueue, {
      onEvict: evicted => {
        if (options?.onOutboundQueueEvict) {
          options.onOutboundQueueEvict(evicted)
        } else {
          this.onOutboundQueueEvict(evicted)
        }
      },
    })
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })
  }

  isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  protected markReady(): void {
    if (!this.ready) {
      this.ready = true
      this.readyPromiseResolver?.()
      this.readyPromiseResolver = null
    }
  }

  isConnected(): boolean {
    return this.connected && !this.isDisconnected
  }

  isSyncPaused(): boolean {
    return this.isPaused
  }

  pause(): void {
    this.isPaused = true
  }

  resume(): void {
    this.isPaused = false
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.connected = true
    this.isDisconnected = false
    this.markReady()
  }

  disconnect(): void {
    this.connected = false
    this.isDisconnected = true
    this.dispatchClose()
  }

  /**
   * Evaluates whether outbound messages can be dispatched immediately.
   * By default, returns true if not explicitly disconnected and not paused.
   * Specialized adapters (e.g. VaultNetworkAdapter) can extend this to require
   * active peer connection, valid account, and send enabled flags.
   */
  protected canSend(): boolean {
    return !this.isDisconnected && !this.isPaused
  }

  /**
   * Buffers an outbound message into the disconnect replay queue.
   */
  protected enqueueOutboundMessage(message: Message): void {
    this.outboundQueue.push(message)
  }

  /**
   * Flushes queued outbound messages if sending is currently permitted.
   */
  protected flushOutboundQueue(): void {
    if (!this.canSend()) {
      return
    }

    while (this.outboundQueue.length > 0) {
      const message = this.outboundQueue.shift()!
      this.processOutboundMessage(message)
    }
  }

  /**
   * Subclass hook to process/deliver a flushed outbound message from the replay queue.
   */
  protected processOutboundMessage(_: Message): void {
    // Override in subclass to process or route flushed messages
  }

  /**
   * Subclass hook when an outbound message is evicted from the bounded queue.
   */
  protected onOutboundQueueEvict(_: Message): void {
    // Override in subclass if eviction handling is needed
  }

  clearOutboundQueue(): void {
    this.outboundQueue.clear()
  }

  getPendingOutboundCount(): number {
    return this.outboundQueue.length
  }

  hasPendingOutboundMessages(): boolean {
    return this.outboundQueue.length > 0
  }

  // --- Automerge Repo adapter event dispatching ---

  dispatchPeerCandidate(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.emit('peer-candidate', {
      peerId,
      peerMetadata: peerMetadata ?? {},
    })
  }

  dispatchPeerDisconnected(peerId: PeerId): void {
    this.emit('peer-disconnected', { peerId })
  }

  dispatchMessage(message: Message): void {
    this.emit('message', message)
  }

  dispatchClose(): void {
    this.emit('close')
  }
}
