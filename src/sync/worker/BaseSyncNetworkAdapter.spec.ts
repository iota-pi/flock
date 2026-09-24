import type { Message, PeerId, PeerMetadata } from '@automerge/automerge-repo/slim'
import {
  BaseSyncNetworkAdapter,
  type BaseSyncNetworkAdapterOptions,
} from './BaseSyncNetworkAdapter'

class ConcreteSyncNetworkAdapter extends BaseSyncNetworkAdapter {
  public processedMessages: Message[] = []
  public evictedMessages: Message[] = []

  constructor(options?: BaseSyncNetworkAdapterOptions) {
    super(options)
  }

  send(message: Message): void {
    if (!this.canSend()) {
      this.enqueueOutboundMessage(message)
      return
    }
    this.flushOutboundQueue()
    this.processOutboundMessage(message)
  }

  protected override processOutboundMessage(message: Message): void {
    this.processedMessages.push(message)
  }

  protected override onOutboundQueueEvict(evicted: Message): void {
    this.evictedMessages.push(evicted)
  }

  // Expose protected methods for testing if needed
  public testCanSend(): boolean {
    return this.canSend()
  }

  public testFlushOutboundQueue(): void {
    this.flushOutboundQueue()
  }

  public testEnqueueOutboundMessage(message: Message): void {
    this.enqueueOutboundMessage(message)
  }
}

describe('BaseSyncNetworkAdapter', () => {
  let adapter: ConcreteSyncNetworkAdapter

  beforeEach(() => {
    adapter = new ConcreteSyncNetworkAdapter({ maxOutboundQueueSize: 5 })
  })

  describe('connection state flags and transitions', () => {
    it('initializes with default connection state flags', () => {
      expect(adapter.isConnected()).toBe(false)
      expect(adapter.isReady()).toBe(false)
      expect(adapter.isSyncPaused()).toBe(false)
      expect(adapter.testCanSend()).toBe(true)
    })

    it('transitions to connected and ready on connect()', async () => {
      const peerId = 'peer-1' as PeerId
      const peerMetadata: PeerMetadata = { isEphemeral: true }

      let resolved = false
      void adapter.whenReady().then(() => {
        resolved = true
      })

      expect(resolved).toBe(false)
      adapter.connect(peerId, peerMetadata)

      expect(adapter.peerId).toBe(peerId)
      expect(adapter.peerMetadata).toBe(peerMetadata)
      expect(adapter.isConnected()).toBe(true)
      expect(adapter.isReady()).toBe(true)

      await Promise.resolve()
      expect(resolved).toBe(true)
    })

    it('transitions to disconnected and emits close on disconnect()', () => {
      const closeSpy = vi.fn()
      adapter.on('close', closeSpy)

      adapter.connect('peer-1' as PeerId)
      expect(adapter.isConnected()).toBe(true)

      adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
      expect(adapter.testCanSend()).toBe(false)
      expect(closeSpy).toHaveBeenCalledTimes(1)
    })

    it('reconnects after disconnect', () => {
      adapter.connect('peer-1' as PeerId)
      adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)

      adapter.connect('peer-1' as PeerId)
      expect(adapter.isConnected()).toBe(true)
      expect(adapter.testCanSend()).toBe(true)
    })

    it('pauses and resumes sync', () => {
      expect(adapter.isSyncPaused()).toBe(false)
      expect(adapter.testCanSend()).toBe(true)

      adapter.pause()
      expect(adapter.isSyncPaused()).toBe(true)
      expect(adapter.testCanSend()).toBe(false)

      adapter.resume()
      expect(adapter.isSyncPaused()).toBe(false)
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

  describe('disconnect buffering and replay', () => {
    it('buffers messages when send is disabled or disconnected', () => {
      adapter.disconnect()
      expect(adapter.getPendingOutboundCount()).toBe(0)
      expect(adapter.hasPendingOutboundMessages()).toBe(false)

      const msg: Message = {
        type: 'sync',
        senderId: 'p1' as PeerId,
        targetId: 'p2' as PeerId,
        data: new Uint8Array([1]),
      }
      adapter.send(msg)

      expect(adapter.getPendingOutboundCount()).toBe(1)
      expect(adapter.hasPendingOutboundMessages()).toBe(true)
      expect(adapter.processedMessages).toHaveLength(0)
    })

    it('replays buffered messages in FIFO order when reconnected and flushed', () => {
      adapter.disconnect()

      const msg1: Message = {
        type: 'sync',
        senderId: 'p1' as PeerId,
        targetId: 'p2' as PeerId,
        data: new Uint8Array([1]),
      }
      const msg2: Message = {
        type: 'sync',
        senderId: 'p1' as PeerId,
        targetId: 'p2' as PeerId,
        data: new Uint8Array([2]),
      }
      adapter.send(msg1)
      adapter.send(msg2)

      expect(adapter.getPendingOutboundCount()).toBe(2)

      // Connect and send next message which triggers flush
      adapter.connect('p1' as PeerId)
      const msg3: Message = {
        type: 'sync',
        senderId: 'p1' as PeerId,
        targetId: 'p2' as PeerId,
        data: new Uint8Array([3]),
      }
      adapter.send(msg3)

      expect(adapter.processedMessages).toEqual([msg1, msg2, msg3])
      expect(adapter.getPendingOutboundCount()).toBe(0)
      expect(adapter.hasPendingOutboundMessages()).toBe(false)
    })

    it('does not flush queue if canSend() is false', () => {
      adapter.pause()

      const msg: Message = {
        type: 'sync',
        senderId: 'p1' as PeerId,
        targetId: 'p2' as PeerId,
        data: new Uint8Array([1]),
      }
      adapter.testEnqueueOutboundMessage(msg)
      expect(adapter.getPendingOutboundCount()).toBe(1)

      adapter.testFlushOutboundQueue()
      expect(adapter.processedMessages).toHaveLength(0)
      expect(adapter.getPendingOutboundCount()).toBe(1)
    })

    it('clears outbound queue', () => {
      adapter.testEnqueueOutboundMessage({
        type: 'sync',
        senderId: 'p1' as PeerId,
        targetId: 'p2' as PeerId,
        data: new Uint8Array([1]),
      })
      expect(adapter.getPendingOutboundCount()).toBe(1)

      adapter.clearOutboundQueue()
      expect(adapter.getPendingOutboundCount()).toBe(0)
      expect(adapter.hasPendingOutboundMessages()).toBe(false)
    })

    it('caps queue and invokes eviction callback on overflow', () => {
      // adapter maxOutboundQueueSize was set to 5
      for (let i = 0; i < 7; i++) {
        adapter.testEnqueueOutboundMessage({
          type: 'sync',
          senderId: 'p1' as PeerId,
          targetId: 'p2' as PeerId,
          data: new Uint8Array([i]),
        })
      }

      expect(adapter.getPendingOutboundCount()).toBe(5)
      expect(adapter.evictedMessages).toHaveLength(2)
      expect(adapter.evictedMessages[0].data).toEqual(new Uint8Array([0]))
      expect(adapter.evictedMessages[1].data).toEqual(new Uint8Array([1]))
    })

    it('supports onOutboundQueueEvict option in constructor', () => {
      const optionsEvictSpy = vi.fn()
      const customAdapter = new ConcreteSyncNetworkAdapter({
        maxOutboundQueueSize: 2,
        onOutboundQueueEvict: optionsEvictSpy,
      })

      customAdapter.testEnqueueOutboundMessage({ type: 'sync', senderId: 'p1' as PeerId, targetId: 'p2' as PeerId })
      customAdapter.testEnqueueOutboundMessage({ type: 'sync', senderId: 'p1' as PeerId, targetId: 'p2' as PeerId })
      customAdapter.testEnqueueOutboundMessage({ type: 'sync', senderId: 'p1' as PeerId, targetId: 'p2' as PeerId })

      expect(optionsEvictSpy).toHaveBeenCalledTimes(1)
    })
  })
})
