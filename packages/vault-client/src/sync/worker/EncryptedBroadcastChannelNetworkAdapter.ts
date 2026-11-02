import type {
  DocumentId,
  Message,
  PeerId,
  PeerMetadata,
} from '@automerge/automerge-repo/slim'
import {
  BroadcastChannelNetworkAdapter,
  type BroadcastChannelNetworkAdapterOptions,
} from '@automerge/automerge-repo-network-broadcastchannel'

import type { CryptoResult } from '../../api/crypto'
import type { KeyProvider } from '../../api/Keyring'
import { BaseSyncNetworkAdapter } from './BaseSyncNetworkAdapter'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { classifySyncError } from '../utils/errorClassifier'
import type { RealtimeBus } from './realtimeBus'
import { toVaultItemIdFromAutomergeId, isIndexDocument } from './utils/automerge'
import { AsyncQueue } from '../utils/AsyncQueue'
import { RetryStrategy } from '../utils/RetryStrategy'
import { BoundedQueue } from '../utils/BoundedQueue'
import { fireAndForget } from '../utils/fireAndForget'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { createLogger } from '../utils/logger'

const log = createLogger('EncryptedBroadcastChannelNetworkAdapter')

const DEFAULT_MAX_CRYPTO_RETRIES = 3
const DEFAULT_CRYPTO_RETRY_DELAY_MS = 50

/**
 * While messages wait for a missing key version, keyring reload requests
 * (`onKeyVersionMissing`) back off by these multiples of `keyWaitTimeoutMs`,
 * repeating the last one. With the default 5s wait this is 5s, 10s, 20s, 40s,
 * 80s, 160s, then every 5 minutes. The wait for the key itself never stops.
 */
const KEY_REQUEST_BACKOFF_MULTIPLIERS = [1, 2, 4, 8, 16, 32, 60] as const

export interface EncryptedBroadcastChannelOptions
  extends Partial<BroadcastChannelNetworkAdapterOptions> {
  /** The keys cross-tab messages are encrypted with */
  keys: KeyProvider
  /** Tells the account's other tabs which items this tab sent */
  bus?: RealtimeBus
  onKeyVersionMissing?: (kver: string) => void
  keyWaitTimeoutMs?: number
  maxPendingMessagesPerKey?: number
  onDocumentReceived?: (documentId: DocumentId) => void
  maxCryptoRetries?: number
  cryptoRetryDelayMs?: number
}

export class EncryptedBroadcastChannelNetworkAdapter extends BaseSyncNetworkAdapter {
  private inner!: BroadcastChannelNetworkAdapter
  private sendQueue: AsyncQueue<Message>
  private receiveQueue: AsyncQueue<Message>
  private pendingKeyMessages = new Map<string, BoundedQueue<Message>>()
  private activeKeyWaiters = new Set<string>()
  private maxPendingMessagesPerKey: number
  private maxCryptoRetries: number
  private cryptoRetryDelayMs: number

  constructor(private readonly deps: EncryptedBroadcastChannelOptions) {
    super()
    this.maxPendingMessagesPerKey = deps.maxPendingMessagesPerKey ?? 1000
    this.maxCryptoRetries = deps.maxCryptoRetries ?? DEFAULT_MAX_CRYPTO_RETRIES
    this.cryptoRetryDelayMs = deps.cryptoRetryDelayMs ?? DEFAULT_CRYPTO_RETRY_DELAY_MS

    this.sendQueue = new AsyncQueue<Message>(message => this.processSendItem(message))
    this.receiveQueue = new AsyncQueue<Message>(message => this.processReceiveItem(message))

    this.setupInner()
  }

  private setupInner(): void {
    this.inner = new BroadcastChannelNetworkAdapter(this.deps as BroadcastChannelNetworkAdapterOptions | undefined)

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

  isReady(): boolean {
    return this.inner.isReady()
  }

  whenReady(): Promise<void> {
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
        const cryptoResult = await this.deps.keys.encryptBytes(message.data)
        const jsonString = JSON.stringify(cryptoResult)
        const encodedData = new TextEncoder().encode(jsonString)
        this.inner.send({ ...message, data: encodedData })
        if (message.documentId && this.deps.bus) {
          const itemId = toVaultItemIdFromAutomergeId(message.documentId)
          if (itemId && !isIndexDocument(itemId)) {
            this.deps.bus.publishSyncPing([itemId])
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
        () => {
          log.warn(
            `Pending queue for key version ${kver} exceeded max capacity (${this.maxPendingMessagesPerKey}). Evicting oldest message.`
          )
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
    const timeout = this.deps.keyWaitTimeoutMs ?? SYNC_TIMEOUTS.keyWait
    // Multiples of `timeout`, so each wait below is a whole `timeout` and the
    // loop rechecks the pending buffer and connection state that often.
    const requestBackoff = new RetryStrategy({
      delays: KEY_REQUEST_BACKOFF_MULTIPLIERS.map(multiplier => multiplier * timeout),
    })
    let untilNextRequestMs = requestBackoff.nextDelay()
    try {
      while (this.hasPendingMessages(kver) && !this.isDisconnected) {
        if (this.deps.keys.hasKey(kver)) {
          this.requeuePendingMessages(kver)
          break
        }

        const waitMs = Math.min(timeout, untilNextRequestMs)
        const keyAcquired = await this.deps.keys.waitForKey(kver, waitMs)
        if (keyAcquired || this.deps.keys.hasKey(kver)) {
          this.requeuePendingMessages(kver)
          break
        }

        untilNextRequestMs -= waitMs
        if (untilNextRequestMs > 0) {
          continue
        }
        untilNextRequestMs = requestBackoff.nextDelay()

        if (this.hasPendingMessages(kver) && !this.isDisconnected && this.deps.onKeyVersionMissing) {
          this.deps.onKeyVersionMissing(kver)
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

        if (!this.deps.keys.hasKey(kver) && this.hasPendingMessages(kver)) {
          this.bufferPendingMessage(kver, message)
          return
        }

        let decryptedData: Uint8Array
        try {
          decryptedData = await decryptWithKeyResolution(this.deps.keys, cryptoResult, {
            timeoutMs: this.deps.keyWaitTimeoutMs ?? SYNC_TIMEOUTS.keyWait,
            onKeyVersionMissing: this.deps.onKeyVersionMissing,
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
        if (message.documentId && this.deps.onDocumentReceived) {
          this.deps.onDocumentReceived(message.documentId)
        }
      } catch (err) {
        // Only a missing key needs a keyring reload. Other failures (such as a
        // decrypt error with the key loaded) are retried without one.
        if (kver && !this.deps.keys.hasKey(kver) && this.deps.onKeyVersionMissing) {
          this.deps.onKeyVersionMissing(kver)
        }
        throw err
      }
    })
  }
}
