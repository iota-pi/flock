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

import type { CryptoResult } from '../../api/crypto'
import type { KeyProvider } from '../../api/Keyring'
import {
  BaseSyncNetworkAdapter,
  type BaseSyncNetworkAdapterOptions,
} from './BaseSyncNetworkAdapter'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { classifySyncError } from '../utils/errorClassifier'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import { toVaultItemIdFromAutomergeId, ACCOUNT_INDEX_DOCUMENT_ID } from './utils/automerge'
import { AsyncQueue } from '../utils/AsyncQueue'
import { RetryStrategy } from '../utils/RetryStrategy'
import { BoundedQueue } from '../utils/boundedCollections'
import { fireAndForget } from '../utils/fireAndForget'
import { getVaultStorageNames } from '../shared/storageNames'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('EncryptedBroadcastChannelNetworkAdapter')

const DEFAULT_MAX_CRYPTO_RETRIES = 3
const DEFAULT_CRYPTO_RETRY_DELAY_MS = 50

export interface EncryptedBroadcastChannelOptions
  extends Partial<BroadcastChannelNetworkAdapterOptions>,
  BaseSyncNetworkAdapterOptions {
  /** The keys cross-tab messages are encrypted with */
  keys: KeyProvider
  accountId?: string
  onKeyVersionMissing?: (kver: string) => void
  keyWaitTimeoutMs?: number
  maxPendingMessagesPerKey?: number
  onDocumentReceived?: (documentId: DocumentId) => void
  maxCryptoRetries?: number
  cryptoRetryDelayMs?: number
}

function accountIdFromChannelName(channelName?: string): string | undefined {
  const prefix = getVaultStorageNames().accountPrefixes.automergeBroadcastChannel
  return channelName?.startsWith(prefix) ? channelName.slice(prefix.length) : undefined
}

export class EncryptedBroadcastChannelNetworkAdapter extends BaseSyncNetworkAdapter {
  private options: EncryptedBroadcastChannelOptions
  private readonly keys: KeyProvider
  private accountId?: string
  private inner!: BroadcastChannelNetworkAdapter
  private sendQueue: AsyncQueue<Message>
  private receiveQueue: AsyncQueue<Message>
  private pendingKeyMessages = new Map<string, BoundedQueue<Message>>()
  private activeKeyWaiters = new Set<string>()
  private maxPendingMessagesPerKey: number
  private maxCryptoRetries: number
  private cryptoRetryDelayMs: number

  constructor(options: EncryptedBroadcastChannelOptions) {
    super(options)
    this.options = options
    this.keys = options.keys
    this.accountId = options.accountId ?? accountIdFromChannelName(options.channelName)
    this.maxPendingMessagesPerKey = options.maxPendingMessagesPerKey ?? 1000
    this.maxCryptoRetries = options.maxCryptoRetries ?? DEFAULT_MAX_CRYPTO_RETRIES
    const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test'
    this.cryptoRetryDelayMs = options.cryptoRetryDelayMs ?? (isTestEnv ? 0 : DEFAULT_CRYPTO_RETRY_DELAY_MS)

    this.sendQueue = new AsyncQueue<Message>(message => this.processSendItem(message))
    this.receiveQueue = new AsyncQueue<Message>(message => this.processReceiveItem(message))

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
    this.sendQueue.push(message)
  }

  /**
   * Runs `attempt` up to `maxCryptoRetries` times, stopping early once the
   * adapter can no longer send. The final failure is logged, not thrown.
   */
  private async withCryptoRetry(label: string, attempt: () => Promise<void>): Promise<void> {
    try {
      await RetryStrategy.executeWithRetry(
        async () => {
          if (this.canSend()) {
            await attempt()
          }
        },
        {
          maxAttempts: this.maxCryptoRetries,
          delays: [this.cryptoRetryDelayMs],
          onRetry: (err, attemptNumber) => {
            log.warn(`Error ${label} message (attempt ${attemptNumber}/${this.maxCryptoRetries}), retrying:`, err)
          },
        },
      )
    } catch (err) {
      log.error(`Error ${label} message:`, err)
    }
  }

  private async processSendItem(message: Message): Promise<void> {
    await this.withCryptoRetry('sending', async () => {
      if (message.type === 'sync' && message.data) {
        const cryptoResult = await this.keys.encryptBytes(message.data)
        const jsonString = JSON.stringify(cryptoResult)
        const encodedData = new TextEncoder().encode(jsonString)
        this.inner.send({ ...message, data: encodedData })
        if (message.documentId && this.accountId) {
          const itemId = toVaultItemIdFromAutomergeId(message.documentId)
          if (itemId && (itemId as string) !== ACCOUNT_INDEX_DOCUMENT_ID) {
            publishRealtimeBusSyncPing(this.accountId, [itemId])
          }
        }
      } else {
        this.inner.send(message)
      }
    })
  }

  private handleIncomingMessage(message: Message): void {
    if (!this.canSend()) {
      return
    }
    this.receiveQueue.push(message)
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
            log.warn(
              `Pending queue for key version ${kver} exceeded max capacity (${this.maxPendingMessagesPerKey}). Evicting oldest message.`
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
    fireAndForget(this.waitForKeyAndDrain(kver), 'EncryptedBroadcastChannel:waitForKeyAndDrain')
  }

  private async waitForKeyAndDrain(kver: string): Promise<void> {
    try {
      while (this.hasPendingMessages(kver) && !this.isDisconnected) {
        if (this.keys.hasKey(kver)) {
          this.requeuePendingMessages(kver)
          break
        }

        const timeout = this.options.keyWaitTimeoutMs ?? SYNC_TIMEOUTS.keyWait
        const keyAcquired = await this.keys.waitForKey(kver, timeout)
        if (keyAcquired || this.keys.hasKey(kver)) {
          this.requeuePendingMessages(kver)
          break
        }

        if (this.hasPendingMessages(kver) && !this.isDisconnected && this.options.onKeyVersionMissing) {
          this.options.onKeyVersionMissing(kver)
        }
      }
    } catch (err) {
      log.error(`Error waiting for key version ${kver}:`, err)
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
    this.receiveQueue.push(...pending)
  }

  private async processReceiveItem(message: Message): Promise<void> {
    await this.withCryptoRetry('decrypting', async () => {
      if (message.type !== 'sync' || !message.data) {
        this.dispatchMessage(message)
        return
      }

      let kver: string | undefined
      try {
        const jsonString = new TextDecoder().decode(message.data)
        const cryptoResult = JSON.parse(jsonString) as CryptoResult
        kver = cryptoResult.kver || '1'

        if (!this.keys.hasKey(kver) && this.hasPendingMessages(kver)) {
          this.bufferPendingMessage(kver, message)
          return
        }

        let decryptedData: Uint8Array
        try {
          decryptedData = await decryptWithKeyResolution(this.keys, cryptoResult, {
            timeoutMs: this.options.keyWaitTimeoutMs ?? SYNC_TIMEOUTS.keyWait,
            onKeyVersionMissing: this.options.onKeyVersionMissing,
          })
        } catch (err) {
          const classified = classifySyncError(err)
          if (classified.isMissingKey) {
            const missingKver = classified.kver ?? '1'
            log.warn(
              `Timed out waiting for key version ${missingKver}. Buffering message until key arrives.`
            )
            this.bufferPendingMessage(missingKver, message)
            this.ensureKeyWaiter(missingKver)
            return
          }
          throw err
        }

        this.dispatchMessage({ ...message, data: decryptedData })
        if (message.documentId && this.options.onDocumentReceived) {
          this.options.onDocumentReceived(message.documentId)
        }
      } catch (err) {
        if (kver && this.options.onKeyVersionMissing) {
          this.options.onKeyVersionMissing(kver)
        }
        throw err
      }
    })
  }
}
