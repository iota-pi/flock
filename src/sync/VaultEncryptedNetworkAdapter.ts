import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
} from '@automerge/automerge-repo/slim'
import { chunk } from 'lodash-es'

import { toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { getActiveSessionToken } from './workerAuthStore'
import { pollSyncBatchWithToken } from '../api/vault/SyncWorkerClient'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'
import { encryptBytesWithKey } from 'src/api/vault/crypto'
import { getVaultKey } from 'src/api/vault'
import {
  persistSyncMessages,
  loadSyncBatch,
  removeSentSyncMessages,
} from './VaultPersistence'

const VAULT_PEER_ID = 'vault' as PeerId

export class VaultEncryptedNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private isOnline = true
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>

  private isPolling = false
  private pollIntervalId: number | null = null
  private readonly pollBackoffStepsMs = [30000, 60000, 120000, 300000]
  private pollBackoffIndex = 0
  private nextPollAt = 0
  private pollingPausedForAuth = false
  private isLeader = false

  private pullQueueManager = new SyncPullQueueManager()

  private syncBatchTimeout: number | null = null
  private pendingWrites: Map<string, Uint8Array[]> = new Map()

  onStartRequest: (() => void) | null = null
  onFinishRequest: (() => void) | null = null
  onSnapshotNeeded: ((cursor: number, requestedAt: number) => void) | null = null
  onAuthFailure: ((message: string) => void) | null = null
  onPollResult: ((outcome: 'success' | 'failure' | 'auth-failure') => void) | null = null

  constructor() {
    super()
    this.readyPromise = new Promise<void>(resolve => {
      this.readyPromiseResolver = resolve
    })

    this.pullQueueManager.onMessageParsed = (itemId, documentId, message) => {
      clearManualRecoveryForItems([itemId]).catch(console.error)
      this.emit('message', {
        type: 'sync',
        senderId: VAULT_PEER_ID,
        targetId: this.peerId!,
        documentId: documentId,
        data: message,
      })
    }
  }

  setLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader
    if (this.isLeader && this.account) {
      this.startPolling(true)
    } else {
      this.stopPolling()
    }
  }

  async setAccount(account: string | null): Promise<void> {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    await this.persistPendingWrites()

    this.account = nextAccount
    this.pollingPausedForAuth = false
    this.resetPollBackoff()
    await this.pullQueueManager.setAccount(this.account)

    if (this.account && this.isLeader) {
      this.startPolling(true)
    } else {
      this.stopPolling()
    }

    if (!this.connected) {
      return
    }

    if (this.account) {
      this.emitPeerCandidate()
    }
  }

  isReady(): boolean {
    return this.ready
  }

  whenReady(): Promise<void> {
    return this.readyPromise
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.connected = true

    if (!this.ready) {
      this.ready = true
      this.readyPromiseResolver?.()
      this.readyPromiseResolver = null
    }

    if (this.account) {
      this.emitPeerCandidate()
    }

    if (this.account && this.isOnline && this.isLeader) {
      this.startPolling(true)
    }
  }

  setOnlineState(isOnline: boolean): void {
    if (this.isOnline === isOnline) {
      return
    }

    this.isOnline = isOnline

    if (!this.connected) {
      return
    }

    if (!isOnline) {
      this.stopPolling()
      return
    }

    if (this.account && this.isLeader) {
      this.resetPollBackoff()
      this.startPolling(true)
    }
  }

  send(message: Message): void {
    if (!this.connected || !this.account || message.targetId !== VAULT_PEER_ID) {
      return
    }

    if (!this.isLeader) {
      return
    }

    if (message.type === 'request') {
      this.handleRequestMessage(message)
    } else if (message.type === 'sync' && message.data instanceof Uint8Array) {
      this.handleSyncMessage(message)
    }
  }

  private handleRequestMessage(message: Message): void {
    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId) {
      return
    }

    const itemId = toVaultItemIdFromAutomergeId(documentId)
    this.pullQueueManager.addPendingItem(itemId)

    this.flush()
  }

  private handleSyncMessage(message: Message): void {
    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId || !(message.data instanceof Uint8Array)) {
      return
    }

    const itemId = toVaultItemIdFromAutomergeId(documentId)

    let messages = this.pendingWrites.get(itemId)
    if (!messages) {
      messages = []
      this.pendingWrites.set(itemId, messages)
    }
    messages.push(message.data as Uint8Array)

    this.flush()
  }

  private async persistPendingWrites(): Promise<void> {
    if (this.pendingWrites.size === 0 || !this.account) {
      return
    }
    await persistSyncMessages(this.account, this.pendingWrites)
  }

  flush(): void {
    if (this.syncBatchTimeout === null) {
      this.syncBatchTimeout = self.setTimeout(
        () => void this.flushSyncBatch(),
        0,
      )
    }
  }

  queuePendingPullItems(itemIds: string[]): void {
    if (!itemIds || itemIds.length === 0) return
    for (const itemId of itemIds) {
      this.pullQueueManager.addPendingItem(itemId)
    }
    this.flush()
  }

  private async flushSyncBatch(): Promise<void> {
    await this.persistPendingWrites()

    if (this.isPolling) {
      // Poll in-flight — re-schedule for after it finishes
      this.syncBatchTimeout = self.setTimeout(() => void this.flushSyncBatch(), 500)
    } else {
      void this.executeWrappedPoll()
      this.syncBatchTimeout = null
    }
  }

  private startPolling(immediate?: boolean): void {
    this.stopPolling()

    if (!this.isLeader) {
      return
    }

    // Immediate first poll
    if (immediate) {
      void this.executeWrappedPoll()
    }

    this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
  }

  private stopPolling(): void {
    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
      this.pollIntervalId = null
    }
    if (this.syncBatchTimeout) {
      self.clearTimeout(this.syncBatchTimeout)
      this.syncBatchTimeout = null
    }
    this.nextPollAt = 0
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.pollingPausedForAuth || !this.connected || !this.isOnline || !this.isLeader) {
      return
    }

    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
    }

    const jitteredDelayMs = this.applyBackoffJitter(delayMs)
    this.nextPollAt = Date.now() + jitteredDelayMs
    this.pollIntervalId = self.setTimeout(() => {
      void this.executeWrappedPoll()
    }, jitteredDelayMs)
  }

  private applyBackoffJitter(delayMs: number): number {
    const jitterWindow = Math.min(15000, Math.floor(delayMs * 0.25))
    if (jitterWindow <= 0) {
      return delayMs
    }

    const offset = Math.floor(Math.random() * (jitterWindow + 1))
    return delayMs + offset
  }

  private resetPollBackoff(): void {
    this.pollBackoffIndex = 0
  }

  private increasePollBackoff(): void {
    this.pollBackoffIndex = Math.min(
      this.pollBackoffIndex + 1,
      this.pollBackoffStepsMs.length - 1,
    )
  }

  private async executeWrappedPoll(): Promise<void> {
    if (this.isPolling || !this.connected || this.pollingPausedForAuth || !this.isOnline) return
    if (this.nextPollAt > 0 && Date.now() < this.nextPollAt) return
    this.isPolling = true

    let outcome: 'success' | 'failure' | 'auth-failure' = 'success'

    try {
      outcome = await this.executePoll()
    } finally {
      this.isPolling = false
    }

    if (!this.connected || this.pollingPausedForAuth) {
      return
    }

    if (outcome === 'auth-failure') {
      this.pollingPausedForAuth = true
      this.stopPolling()
      this.onAuthFailure?.('Sync paused: your session has expired. Please sign in again.')
      this.onPollResult?.(outcome)
      return
    }

    if (outcome === 'failure') {
      this.increasePollBackoff()
    } else {
      this.resetPollBackoff()
    }

    this.onPollResult?.(outcome)

    this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
  }

  private async executePoll(): Promise<'success' | 'failure' | 'auth-failure'> {
    if (!this.account || !this.isOnline) return 'success'

    const authToken = await getActiveSessionToken()
    if (!authToken) return 'success'

    // 1. Load pending sync messages from IndexedDB for the current account
    let batchEntries: [string, Uint8Array[]][] = []
    try {
      batchEntries = await loadSyncBatch(this.account)
    } catch (err) {
      return 'failure'
    }

    // 2. Chunk entries using lodash's chunk helper (5 items per chunk)
    const chunks = chunk(batchEntries, 5)

    const pullCursors = this.pullQueueManager.getAllCursors()
    if (chunks.length === 0 && pullCursors.length === 0) {
      return 'success'
    }

    this.onStartRequest?.()
    try {
      // If there are no outgoing messages but we have pull cursors, run a single pull poll
      if (chunks.length === 0) {
        const response = await pollSyncBatchWithToken({
          account: this.account,
          authToken,
          pushMessages: [],
          pullCursors
        })

        if (response && response.pushResults) {
          this.pullQueueManager.processPushResults(response.pushResults)
        }

        if (response && response.pullResults) {
          await this.pullQueueManager.processPullResults(response.pullResults)
        }

        if (response?.snapshotRequest?.requested) {
          this.onSnapshotNeeded?.(response.snapshotRequest.cursor, response.snapshotRequest.requestedAt)
        }

        return 'success'
      }

      // Process each chunk in a sequence
      for (const chunkEntry of chunks) {
        // 3. Encrypt the outgoing messages for this chunk
        const pushMessages = await Promise.all(
          chunkEntry.map(async ([itemId, messages]) => {
            let totalLength = 0
            for (const m of messages) {
              totalLength += 4 + m.length
            }
            const combined = new Uint8Array(totalLength)
            const view = new DataView(combined.buffer)
            let offset = 0
            for (const m of messages) {
              view.setUint32(offset, m.length, false)
              offset += 4
              combined.set(m, offset)
              offset += m.length
            }

            const encryptedMessage = await encryptBytesWithKey(getVaultKey(), combined)
            return {
              itemId,
              encryptedMessage: {
                iv: encryptedMessage.iv,
                cipher: encryptedMessage.cipher,
                version: '1.0',
              }
            }
          })
        )

        // 4. Execute tRPC call for this chunk
        const response = await pollSyncBatchWithToken({
          account: this.account,
          authToken,
          pushMessages,
          pullCursors
        })

        // 5. Process incoming messages
        if (response && response.pushResults) {
          this.pullQueueManager.processPushResults(response.pushResults)
        }

        if (response && response.pullResults) {
          await this.pullQueueManager.processPullResults(response.pullResults)
        }

        if (response?.snapshotRequest?.requested) {
          this.onSnapshotNeeded?.(response.snapshotRequest.cursor, response.snapshotRequest.requestedAt)
        }

        // 6. Transactionally remove sent messages from IndexedDB for this chunk
        await removeSentSyncMessages(this.account, chunkEntry)
      }

      return 'success'
    } catch (error) {
      if (this.isAuthError(error)) {
        console.error('[VaultEncryptedNetworkAdapter] Auth failure during polling', error)
        return 'auth-failure'
      }

      console.error('[VaultEncryptedNetworkAdapter] Polling failed', error)
      return 'failure'
    } finally {
      this.onFinishRequest?.()
    }
  }

  private isAuthError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false
    }

    const anyError = error as { [key: string]: unknown }
    const data = (anyError.data || (anyError as { shape?: { data?: unknown } }).shape?.data) as
      | { httpStatus?: number; code?: string }
      | undefined
    const httpStatus = data?.httpStatus
    if (httpStatus === 401 || httpStatus === 403) {
      return true
    }

    const code = data?.code || (anyError.code as string | undefined)
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      return true
    }

    const message = typeof (anyError as { message?: unknown }).message === 'string'
      ? ((anyError as { message: string }).message).toLowerCase()
      : ''
    return message.includes('unauthorized') || message.includes('forbidden')
  }

  async disconnect(): Promise<void> {
    this.connected = false
    this.pullQueueManager.clear()
    this.stopPolling()
    await this.persistPendingWrites()
    this.emit('close')
  }

  private emitPeerCandidate(): void {
    this.emit('peer-candidate', {
      peerId: VAULT_PEER_ID,
      peerMetadata: {
        storageId: `vault:${this.account}` as StorageId,
        isEphemeral: false,
      },
    })
  }
}
