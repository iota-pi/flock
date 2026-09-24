import {
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
  hasVaultKey,
  waitForKeyVersion,
  type CryptoResult,
} from 'src/api/vault'
import {
  BaseSyncNetworkAdapter,
  type BaseSyncNetworkAdapterOptions,
} from './BaseSyncNetworkAdapter'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { classifySyncError } from './utils/errorClassifier'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import { toVaultItemIdFromAutomergeId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import { AsyncQueue } from './utils/AsyncQueue'
import { BoundedQueue } from '../utils/boundedCollections'

export const DEFAULT_MAX_CRYPTO_RETRIES = 3
export const DEFAULT_CRYPTO_RETRY_DELAY_MS = 50

export interface EncryptedBroadcastChannelOptions
  extends Partial<BroadcastChannelNetworkAdapterOptions>,
  BaseSyncNetworkAdapterOptions {
  accountId?: string
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

export class EncryptedBroadcastChannelNetworkAdapter extends BaseSyncNetworkAdapter {
  private options?: EncryptedBroadcastChannelOptions
  private accountId?: string
  private inner!: BroadcastChannelNetworkAdapter
  private sendQueue: AsyncQueue<QueuedMessage>
  private receiveQueue: AsyncQueue<QueuedMessage>
  private pendingKeyMessages = new Map<string, BoundedQueue<Message>>()
  private activeKeyWaiters = new Set<string>()
  private maxPendingMessagesPerKey: number
  private maxCryptoRetries: number
  private cryptoRetryDelayMs: number

  constructor(options?: EncryptedBroadcastChannelOptions) {
    super(options)
    this.options = options
    this.accountId = options?.accountId ?? (options?.channelName?.startsWith('flock-automerge-broadcast-') ? options.channelName.slice('flock-automerge-broadcast-'.length) : undefined)
    this.maxPendingMessagesPerKey = options?.maxPendingMessagesPerKey ?? 1000
    this.maxCryptoRetries = options?.maxCryptoRetries ?? DEFAULT_MAX_CRYPTO_RETRIES
    const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test'
    this.cryptoRetryDelayMs = options?.cryptoRetryDelayMs ?? (isTestEnv ? 0 : DEFAULT_CRYPTO_RETRY_DELAY_MS)

    this.sendQueue = new AsyncQueue<QueuedMessage>(item => this.processSendItem(item))
    this.receiveQueue = new AsyncQueue<QueuedMessage>(item => this.processReceiveItem(item))

    this.setupInner()
  }

  private setupInner(): void {
    this.inner = new BroadcastChannelNetworkAdapter(this.options as BroadcastChannelNetworkAdapterOptions | undefined)

    // Forward events via base dispatcher methods
    this.inner.on('peer-candidate', payload => this.dispatchPeerCandidate(payload.peerId, payload.peerMetadata))
    this.inner.on('peer-disconnected', payload => this.dispatchPeerDisconnected(payload.peerId))
    this.inner.on('message', message => this.handleIncomingMessage(message))
    this.inner.on('close', () => {
      if (!this.isDisconnected) {
        this.dispatchClose()
      }
    })
  }

  override isReady(): boolean {
    return this.inner.isReady()
  }

  override whenReady(): Promise<void> {
    return this.inner.whenReady()
  }

  override connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    super.connect(peerId, peerMetadata)
    this.inner.connect(peerId, peerMetadata)
  }

  override disconnect(): void {
    super.disconnect()
    this.pendingKeyMessages.clear()
    this.activeKeyWaiters.clear()
    this.receiveQueue.clear()
    this.sendQueue.clear()
    this.inner.disconnect()
  }

  override pause(): void {
    super.pause()
    this.sendQueue.clear()
    this.receiveQueue.clear()
  }

  override resume(): void {
    super.resume()
  }

  send(message: Message): void {
    if (!this.canSend()) {
      return
    }
    this.sendQueue.push({ message, retries: 0 })
  }

  private async processSendItem(item: QueuedMessage): Promise<void> {
    while (item.retries < this.maxCryptoRetries) {
      if (!this.canSend()) {
        return
      }
      try {
        if (item.message.type === 'sync' && item.message.data) {
          const cryptoResult = await encryptBytes(item.message.data)
          const jsonString = JSON.stringify(cryptoResult)
          const encodedData = new TextEncoder().encode(jsonString)
          this.inner.send({ ...item.message, data: encodedData })
          if (item.message.documentId && this.accountId) {
            const itemId = toVaultItemIdFromAutomergeId(item.message.documentId)
            if (itemId && (itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
              publishRealtimeBusSyncPing(this.accountId, [itemId])
            }
          }
        } else {
          this.inner.send(item.message)
        }
        return
      } catch (err) {
        item.retries += 1
        if (item.retries >= this.maxCryptoRetries) {
          console.error('[EncryptedBroadcastChannel] Error sending message:', err)
          return
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
  }

  private handleIncomingMessage(message: Message): void {
    if (!this.canSend()) {
      return
    }
    this.receiveQueue.push({ message, retries: 0 })
  }

  private hasPendingMessages(kver: string): boolean {
    const pending = this.pendingKeyMessages.get(kver)
    return Boolean(pending && pending.length > 0)
  }

  private bufferPendingMessage(kver: string, message: Message): void {
    const pending = this.pendingKeyMessages.getOrInsertComputed(
      kver,
      () => new BoundedQueue<Message>(
        this.maxPendingMessagesPerKey,
        {
          onEvict: () => {
            console.warn(
              `[EncryptedBroadcastChannel] Pending queue for key version ${kver} exceeded max capacity (${this.maxPendingMessagesPerKey}). Evicting oldest message.`
            )
          },
        },
      ),
    )
    pending.push(message)
  }

  private ensureKeyWaiter(kver: string): void {
    if (this.activeKeyWaiters.has(kver)) return
    this.activeKeyWaiters.add(kver)
    void this.waitForKeyAndDrain(kver)
  }

  private async waitForKeyAndDrain(kver: string): Promise<void> {
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

  private requeuePendingMessages(kver: string): void {
    const pending = this.pendingKeyMessages.get(kver)
    if (!pending || pending.length === 0) {
      this.pendingKeyMessages.delete(kver)
      return
    }
    this.pendingKeyMessages.delete(kver)
    this.receiveQueue.unshift(...pending.map(message => ({ message, retries: 0 })))
  }

  private async processReceiveItem(item: QueuedMessage): Promise<void> {
    while (item.retries < this.maxCryptoRetries) {
      if (!this.canSend()) {
        return
      }
      const message = item.message
      let kver: string | undefined
      try {
        if (message.type === 'sync' && message.data) {
          const jsonString = new TextDecoder().decode(message.data)
          const cryptoResult = JSON.parse(jsonString) as CryptoResult
          kver = cryptoResult.kver || '1'

          if (!hasVaultKey(kver) && this.hasPendingMessages(kver)) {
            this.bufferPendingMessage(kver, message)
            return
          }

          let decryptedData: Uint8Array
          try {
            decryptedData = await decryptWithKeyResolution(cryptoResult, {
              timeoutMs: this.options?.keyWaitTimeoutMs ?? 5000,
              onKeyVersionMissing: this.options?.onKeyVersionMissing,
            })
          } catch (err) {
            const classified = classifySyncError(err)
            if (classified.isMissingKey) {
              const kver = classified.kver ?? '1'
              console.warn(
                `[EncryptedBroadcastChannel] Timed out waiting for key version ${kver}. Buffering message until key arrives.`
              )
              this.bufferPendingMessage(kver, message)
              this.ensureKeyWaiter(kver)
              return
            }
            throw err
          }

          this.dispatchMessage({ ...message, data: decryptedData })
          if (message.documentId && this.options?.onDocumentReceived) {
            this.options.onDocumentReceived(message.documentId)
          }
        } else {
          this.dispatchMessage(message)
        }
        return
      } catch (err) {
        item.retries += 1
        if (item.retries >= this.maxCryptoRetries) {
          console.error('[EncryptedBroadcastChannel] Error decrypting message:', err)
          if (kver && this.options?.onKeyVersionMissing) {
            this.options.onKeyVersionMissing(kver)
          }
          return
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
  }
}
