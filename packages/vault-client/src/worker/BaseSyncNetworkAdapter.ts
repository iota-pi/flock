import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo/slim'

/**
 * BaseSyncNetworkAdapter holds the connection state shared by the vault network
 * adapters, and dispatches Automerge Repo adapter events.
 */
export abstract class BaseSyncNetworkAdapter extends NetworkAdapter {
  /**
   * `'new'` (before the first connect) differs from `'disconnected'`: an adapter that was
   * never connected may still send.
   */
  protected connectionState: 'new' | 'connected' | 'disconnected' = 'new'

  protected get isDisconnected(): boolean {
    return this.connectionState === 'disconnected'
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
   * By default, returns true if not explicitly disconnected.
   * Specialized adapters can extend this to require
   * active peer connection, valid account, and send enabled flags.
   */
  protected canSend(): boolean {
    return !this.isDisconnected
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
