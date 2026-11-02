import type { Message, PeerId, PeerMetadata } from '@automerge/automerge-repo/slim'
import { BaseSyncNetworkAdapter } from './BaseSyncNetworkAdapter'

class ConcreteSyncNetworkAdapter extends BaseSyncNetworkAdapter {
  isReady(): boolean {
    return true
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  send(): void {}

  public testCanSend(): boolean {
    return this.canSend()
  }
}

describe('BaseSyncNetworkAdapter', () => {
  let adapter: ConcreteSyncNetworkAdapter

  beforeEach(() => {
    adapter = new ConcreteSyncNetworkAdapter()
  })

  describe('connection and pause state', () => {
    it('can send before the first connect', () => {
      expect(adapter.testCanSend()).toBe(true)
    })

    it('records the peer on connect()', () => {
      const peerId = 'peer-1' as PeerId
      const peerMetadata: PeerMetadata = { isEphemeral: true }

      adapter.connect(peerId, peerMetadata)

      expect(adapter.peerId).toBe(peerId)
      expect(adapter.peerMetadata).toBe(peerMetadata)
      expect(adapter.testCanSend()).toBe(true)
    })

    it('stops sending and emits close on disconnect()', () => {
      const closeSpy = vi.fn()
      adapter.on('close', closeSpy)

      adapter.connect('peer-1' as PeerId)
      adapter.disconnect()

      expect(adapter.testCanSend()).toBe(false)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    })

    it('can send again after reconnecting', () => {
      adapter.connect('peer-1' as PeerId)
      adapter.disconnect()
      adapter.connect('peer-1' as PeerId)

      expect(adapter.testCanSend()).toBe(true)
    })

    it('pauses and resumes sync', () => {
      adapter.pause()
      expect(adapter.testCanSend()).toBe(false)

      adapter.resume()
      expect(adapter.testCanSend()).toBe(true)
    })
  })

  describe('event dispatching', () => {
    it('dispatches peer-candidate event', () => {
      const candidateSpy = vi.fn()
      adapter.on('peer-candidate', candidateSpy)

      const peerId = 'peer-a' as PeerId
      const peerMetadata: PeerMetadata = { isEphemeral: false }
      adapter.dispatchPeerCandidate(peerId, peerMetadata)

      expect(candidateSpy).toHaveBeenCalledWith({
        peerId,
        peerMetadata,
      })
    })

    it('dispatches peer-candidate with default empty metadata if none provided', () => {
      const candidateSpy = vi.fn()
      adapter.on('peer-candidate', candidateSpy)

      const peerId = 'peer-b' as PeerId
      adapter.dispatchPeerCandidate(peerId)

      expect(candidateSpy).toHaveBeenCalledWith({
        peerId,
        peerMetadata: {},
      })
    })

    it('dispatches peer-disconnected event', () => {
      const disconnectedSpy = vi.fn()
      adapter.on('peer-disconnected', disconnectedSpy)

      const peerId = 'peer-c' as PeerId
      adapter.dispatchPeerDisconnected(peerId)

      expect(disconnectedSpy).toHaveBeenCalledWith({ peerId })
    })

    it('dispatches message event', () => {
      const messageSpy = vi.fn()
      adapter.on('message', messageSpy)

      const message: Message = {
        type: 'sync',
        senderId: 'peer-1' as PeerId,
        targetId: 'peer-2' as PeerId,
        data: new Uint8Array([1, 2, 3]),
      }
      adapter.dispatchMessage(message)

      expect(messageSpy).toHaveBeenCalledWith(message)
    })

    it('dispatches close event', () => {
      const closeSpy = vi.fn()
      adapter.on('close', closeSpy)

      adapter.dispatchClose()
      expect(closeSpy).toHaveBeenCalledTimes(1)
    })
  })
})
