import {
  NetworkAdapter,
  type DocumentId,
  type Message,
  type PeerId,
  type PeerMetadata,
} from '@automerge/automerge-repo/slim'
import {
  BroadcastChannelNetworkAdapter,
  type BroadcastChannelNetworkAdapterOptions,
} from '@automerge/automerge-repo-network-broadcastchannel'

import {
  encryptBytes,
  decryptBytes,
  hasVaultKey,
  waitForKeyVersion,
  type CryptoResult,
} from 'src/api/vault'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { toVaultItemIdFromAutomergeId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'

export const DEFAULT_MAX_CRYPTO_RETRIES = 3
export const DEFAULT_CRYPTO_RETRY_DELAY_MS = 50

export interface EncryptedBroadcastChannelOptions extends Partial<BroadcastChannelNetworkAdapterOptions> {
  onKeyVersionMissing?: (kver: string) => void
  keyWaitTimeoutMs?: number
  maxPendingMessagesPerKey?: number
  onDocumentReceived?: (documentId: DocumentId) => void
  /** @deprecated No longer used. Connection is no longer reset on crypto failures. */
  resetCooldownMs?: number
  maxCryptoRetries?: number
  cryptoRetryDelayMs?: number
}

interface QueuedMessage {
  message: Message
  retries: number
}

export class EncryptedBroadcastChannelNetworkAdapter extends NetworkAdapter {
  private options?: EncryptedBroadcastChannelOptions
  private inner!: BroadcastChannelNetworkAdapter
  private sendQueue: QueuedMessage[] = []
  private isSending = false
  private receiveQueue: QueuedMessage[] = []
  private isReceiving = false
  private pendingKeyMessages = new Map<string, Message[]>()
  private activeKeyWaiters = new Set<string>()
  private isDisconnected = false
  private isPaused = false
  private maxPendingMessagesPerKey: number
  private maxCryptoRetries: number
  private cryptoRetryDelayMs: number

  constructor(options?: EncryptedBroadcastChannelOptions) {
    super()
    this.options = options
    this.maxPendingMessagesPerKey = options?.maxPendingMessagesPerKey ?? 1000
    this.maxCryptoRetries = options?.maxCryptoRetries ?? DEFAULT_MAX_CRYPTO_RETRIES
    const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test'
    this.cryptoRetryDelayMs = options?.cryptoRetryDelayMs ?? (isTestEnv ? 0 : DEFAULT_CRYPTO_RETRY_DELAY_MS)
    this.setupInner()
  }

  private setupInner() {
    this.inner = new BroadcastChannelNetworkAdapter(this.options as BroadcastChannelNetworkAdapterOptions | undefined)

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
    this.isDisconnected = false
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.inner.connect(peerId, peerMetadata)
  }

  disconnect() {
    this.isDisconnected = true
    this.pendingKeyMessages.clear()
    this.activeKeyWaiters.clear()
    this.receiveQueue = []
    this.sendQueue = []
    this.inner.disconnect()
  }

  pause(): void {
    this.isPaused = true
    this.sendQueue = []
    this.receiveQueue = []
  }

  resume(): void {
    this.isPaused = false
  }

  isSyncPaused(): boolean {
    return this.isPaused
  }

  send(message: Message) {
    if (this.isDisconnected || this.isPaused) {
      return
    }
    this.sendQueue.push({ message, retries: 0 })
    void this.processQueue()
  }

  private async processQueue() {
    if (this.isSending) return
    this.isSending = true
    try {
      while (this.sendQueue.length > 0) {
        if (this.isDisconnected || this.isPaused) {
          this.sendQueue = []
          break
        }
        const item = this.sendQueue[0]
        try {
          if (item.message.type === 'sync' && item.message.data) {
            const cryptoResult = await encryptBytes(item.message.data)
            const jsonString = JSON.stringify(cryptoResult)
            const encodedData = new TextEncoder().encode(jsonString)
            this.inner.send({ ...item.message, data: encodedData })
            if (item.message.documentId) {
              const itemId = toVaultItemIdFromAutomergeId(item.message.documentId)
              if (itemId && (itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
                publishRealtimeBusSyncPing([itemId])
              }
            }
          } else {
            this.inner.send(item.message)
          }
          this.sendQueue.shift()
        } catch (err) {
          item.retries += 1
          if (item.retries >= this.maxCryptoRetries) {
            console.error('[EncryptedBroadcastChannel] Error sending message:', err)
            this.sendQueue.shift()
          } else {
            console.warn(
              `[EncryptedBroadcastChannel] Error sending message (attempt ${item.retries}/${this.maxCryptoRetries}), retrying:`,
              err
            )
            if (this.cryptoRetryDelayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, this.cryptoRetryDelayMs))
            }
          }
        }
      }
    } finally {
      this.isSending = false
    }
  }

  private handleIncomingMessage(message: Message) {
    if (this.isDisconnected || this.isPaused) {
      return
    }
    this.receiveQueue.push({ message, retries: 0 })
    void this.processReceiveQueue()
  }

  private hasPendingMessages(kver: string): boolean {
    const pending = this.pendingKeyMessages.get(kver)
    return Boolean(pending && pending.length > 0)
  }

  private bufferPendingMessage(kver: string, message: Message) {
    let pending = this.pendingKeyMessages.get(kver)
    if (!pending) {
      pending = []
      this.pendingKeyMessages.set(kver, pending)
    }
    if (pending.length >= this.maxPendingMessagesPerKey) {
      console.warn(
        `[EncryptedBroadcastChannel] Pending queue for key version ${kver} exceeded max capacity (${this.maxPendingMessagesPerKey}). Evicting oldest message.`
      )
      pending.shift()
    }
    pending.push(message)
  }

  private ensureKeyWaiter(kver: string) {
    if (this.activeKeyWaiters.has(kver)) return
    this.activeKeyWaiters.add(kver)
    void this.waitForKeyAndDrain(kver)
  }

  private async waitForKeyAndDrain(kver: string) {
    try {
      while (this.hasPendingMessages(kver) && !this.isDisconnected) {
        if (hasVaultKey(kver)) {
          this.requeuePendingMessages(kver)
          break
        }

        const timeout = this.options?.keyWaitTimeoutMs ?? 5000
        const keyAcquired = await waitForKeyVersion(kver, timeout)
        if (keyAcquired || hasVaultKey(kver)) {
          this.requeuePendingMessages(kver)
          break
        }

        if (this.hasPendingMessages(kver) && !this.isDisconnected && this.options?.onKeyVersionMissing) {
          this.options.onKeyVersionMissing(kver)
        }
      }
    } catch (err) {
      console.error(`[EncryptedBroadcastChannel] Error waiting for key version ${kver}:`, err)
    } finally {
      this.activeKeyWaiters.delete(kver)
    }
  }

  private requeuePendingMessages(kver: string) {
    const pending = this.pendingKeyMessages.get(kver)
    if (!pending || pending.length === 0) {
      this.pendingKeyMessages.delete(kver)
      return
    }
    this.pendingKeyMessages.delete(kver)
    this.receiveQueue.unshift(...pending.map(message => ({ message, retries: 0 })))
    void this.processReceiveQueue()
  }

  private async processReceiveQueue() {
    if (this.isReceiving) return
    this.isReceiving = true
    try {
      while (this.receiveQueue.length > 0) {
        if (this.isDisconnected || this.isPaused) {
          this.receiveQueue = []
          break
        }
        const item = this.receiveQueue[0]
        const message = item.message
        let kver: string | undefined
        try {
          if (message.type === 'sync' && message.data) {
            const jsonString = new TextDecoder().decode(message.data)
            const cryptoResult = JSON.parse(jsonString) as CryptoResult
            kver = cryptoResult.kver || '1'

            if (!hasVaultKey(kver)) {
              if (this.hasPendingMessages(kver)) {
                this.receiveQueue.shift()
                this.bufferPendingMessage(kver, message)
                continue
              }

              if (this.options?.onKeyVersionMissing) {
                this.options.onKeyVersionMissing(kver)
              }
              const timeout = this.options?.keyWaitTimeoutMs ?? 5000
              const keyAcquired = await waitForKeyVersion(kver, timeout)
              if (!keyAcquired && !hasVaultKey(kver)) {
                console.warn(
                  `[EncryptedBroadcastChannel] Timed out waiting for key version ${kver}. Buffering message until key arrives.`
                )
                this.receiveQueue.shift()
                this.bufferPendingMessage(kver, message)
                this.ensureKeyWaiter(kver)
                continue
              }
            }

            const decryptedData = await decryptBytes(cryptoResult)
            this.emit('message', { ...message, data: decryptedData })
            if (message.documentId && this.options?.onDocumentReceived) {
              this.options.onDocumentReceived(message.documentId)
            }
          } else {
            this.emit('message', message)
          }
          this.receiveQueue.shift()
        } catch (err) {
          item.retries += 1
          if (item.retries >= this.maxCryptoRetries) {
            console.error('[EncryptedBroadcastChannel] Error decrypting message:', err)
            if (kver && this.options?.onKeyVersionMissing) {
              this.options.onKeyVersionMissing(kver)
            }
            this.receiveQueue.shift()
          } else {
            console.warn(
              `[EncryptedBroadcastChannel] Error decrypting message (attempt ${item.retries}/${this.maxCryptoRetries}), retrying:`,
              err
            )
            if (kver && this.options?.onKeyVersionMissing) {
              this.options.onKeyVersionMissing(kver)
            }
            if (this.cryptoRetryDelayMs > 0) {
              await new Promise(resolve => setTimeout(resolve, this.cryptoRetryDelayMs))
            }
          }
        }
      }
    } finally {
      this.isReceiving = false
    }
  }
}
