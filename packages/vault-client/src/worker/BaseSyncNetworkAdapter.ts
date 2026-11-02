import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo/slim'

/**
 * BaseSyncNetworkAdapter holds the connection and pause state shared by the vault network
 * adapters, and dispatches Automerge Repo adapter events.
 */
export abstract class BaseSyncNetworkAdapter extends NetworkAdapter {
  /**
   * `'new'` (before the first connect) differs from `'disconnected'`: an adapter that was
   * never connected may still send.
   */
  protected connectionState: 'new' | 'connected' | 'disconnected' = 'new'
  protected isPaused = false

  protected get isDisconnected(): boolean {
    return this.connectionState === 'disconnected'
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
    this.connectionState = 'connected'
  }

  disconnect(): void {
    this.connectionState = 'disconnected'
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
