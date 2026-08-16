import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo/slim'
import {
  BroadcastChannelNetworkAdapter,
  type BroadcastChannelNetworkAdapterOptions,
} from '@automerge/automerge-repo-network-broadcastchannel'

import { encryptBytes, decryptBytes, type CryptoResult } from 'src/api/vault'


export class EncryptedBroadcastChannelNetworkAdapter extends NetworkAdapter {
  private inner: BroadcastChannelNetworkAdapter
  private sendQueue: Message[] = []
  private isSending = false
  private receiveQueue: Message[] = []
  private isReceiving = false

  constructor(options?: BroadcastChannelNetworkAdapterOptions) {
    super()
    this.inner = new BroadcastChannelNetworkAdapter(options)

    // Forward events
    this.inner.on('peer-candidate', payload => this.emit('peer-candidate', payload))
    this.inner.on('peer-disconnected', payload => this.emit('peer-disconnected', payload))
    this.inner.on('message', message => this.handleIncomingMessage(message))
    this.inner.on('close', () => this.emit('close'))
  }

  isReady(): boolean {
    return this.inner.isReady()
  }

  whenReady(): Promise<void> {
    return this.inner.whenReady()
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata) {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.inner.connect(peerId, peerMetadata)
  }

  disconnect() {
    this.inner.disconnect()
  }

  send(message: Message) {
    this.sendQueue.push(message)
    void this.processQueue()
  }

  private async processQueue() {
    if (this.isSending) return
    this.isSending = true
    try {
      while (this.sendQueue.length > 0) {
        const message = this.sendQueue.shift()!
        try {
          if (message.type === 'sync' && message.data) {
            const cryptoResult = await encryptBytes(message.data)
            const jsonString = JSON.stringify(cryptoResult)
            const encodedData = new TextEncoder().encode(jsonString)
            this.inner.send({ ...message, data: encodedData })
          } else {
            this.inner.send(message)
          }
        } catch (err) {
          console.error('[EncryptedBroadcastChannel] Error sending message:', err)
        }
      }
    } finally {
      this.isSending = false
    }
  }

  private handleIncomingMessage(message: Message) {
    this.receiveQueue.push(message)
    void this.processReceiveQueue()
  }

  private async processReceiveQueue() {
    if (this.isReceiving) return
    this.isReceiving = true
    try {
      while (this.receiveQueue.length > 0) {
        const message = this.receiveQueue.shift()!
        try {
          if (message.type === 'sync' && message.data) {
            const jsonString = new TextDecoder().decode(message.data)
            const cryptoResult = JSON.parse(jsonString) as CryptoResult
            const decryptedData = await decryptBytes(cryptoResult)
            this.emit('message', { ...message, data: decryptedData })
          } else {
            this.emit('message', message)
          }
        } catch (err) {
          console.error('[EncryptedBroadcastChannel] Error decrypting message:', err)
        }
      }
    } finally {
      this.isReceiving = false
    }
  }
}
