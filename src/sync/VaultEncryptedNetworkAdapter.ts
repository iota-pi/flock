import {
  NetworkAdapter,
  type Message,
  type PeerId,
  type PeerMetadata,
  type StorageId,
} from '@automerge/automerge-repo/slim'
import { toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { encryptSyncMessage } from './automergeSyncCrypto'
import { getActiveSessionToken } from './workerAuthStore'
import { pollSyncBatchWithToken } from '../api/vault/SyncWorkerClient'
import { SyncPullQueueManager } from './SyncPullQueueManager'
import { clearManualRecoveryForItems } from '../api/syncHealthCoordinator'

const VAULT_PEER_ID = 'vault' as PeerId

export class VaultEncryptedNetworkAdapter extends NetworkAdapter {
  private account: string | null = null
  private connected = false
  private ready = false
  private readyPromiseResolver: (() => void) | null = null
  private readonly readyPromise: Promise<void>

  private isPolling = false
  private pollIntervalId: number | null = null

  private pullQueueManager = new SyncPullQueueManager()

  private syncBatchTimeout: number | null = null
  private syncBatch: Map<string, Uint8Array[]> = new Map()

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

  async setAccount(account: string | null): Promise<void> {
    const nextAccount = account && account.length > 0 ? account : null
    if (this.account === nextAccount) {
      return
    }

    this.account = nextAccount
    await this.pullQueueManager.setAccount(this.account)

    if (this.account) {
      this.startPolling()
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
  }

  send(message: Message): void {
    if (!this.connected || !this.account || message.targetId !== VAULT_PEER_ID) {
      return
    }

    if ((message.type !== 'sync' && message.type !== 'request') || !(message.data instanceof Uint8Array)) {
      return
    }

    const documentId = typeof message.documentId === 'string' ? message.documentId : undefined
    if (!documentId) {
      return
    }

    const itemId = toVaultItemIdFromAutomergeId(documentId)

    let messages = this.syncBatch.get(itemId)
    if (!messages) {
      messages = []
      this.syncBatch.set(itemId, messages)
    }
    messages.push(message.data as Uint8Array)

    if (this.syncBatchTimeout === null) {
      this.syncBatchTimeout = self.setTimeout(() => this.flushSyncBatch(), 0)
    }
  }

  flush(): Promise<void> {
    return this.flushSyncBatch()
  }

  private async flushSyncBatch(): Promise<void> {
    this.syncBatchTimeout = null
    if (this.isPolling) {
      // Poll in-flight — re-schedule for after it finishes
      this.syncBatchTimeout = self.setTimeout(() => this.flushSyncBatch(), 500)
    } else {
      void this.executePoll()
    }
  }

  private startPolling(): void {
    this.stopPolling()

    // Immediate first poll
    void this.executePoll()

    this.pollIntervalId = self.setInterval(() => {
      void this.executePoll()
    }, 30000)
  }

  private stopPolling(): void {
    if (this.pollIntervalId) {
      self.clearInterval(this.pollIntervalId)
      this.pollIntervalId = null
    }
    if (this.syncBatchTimeout) {
      self.clearTimeout(this.syncBatchTimeout)
      this.syncBatchTimeout = null
    }
  }

  private async executePoll(): Promise<void> {
    if (this.isPolling || !this.account || !this.connected) return
    this.isPolling = true

    const authToken = await getActiveSessionToken()
    if (!authToken) return

    // 1. Drain the current queue
    const batchEntries = Array.from(this.syncBatch.entries())
    this.syncBatch.clear()

    try {
      // 2. Encrypt the outgoing messages
      const pushMessages = await Promise.all(
        batchEntries.map(async ([itemId, messages]) => {
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

          const encryptedMessage = await encryptSyncMessage(combined)
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

      // 3. Get pull cursors
      const pullCursors = this.pullQueueManager.getAllCursors()

      if (pushMessages.length === 0 && pullCursors.length === 0) {
        return
      }

      // 4. Execute tRPC call
      const response = await pollSyncBatchWithToken({
        account: this.account,
        authToken,
        pushMessages,
        pullCursors
      })

      // 5. Process incoming messages
      if (response && response.pullResults) {
        await this.pullQueueManager.processPullResults(response.pullResults)
      }
    } catch (error) {
      console.error('[VaultEncryptedNetworkAdapter] Polling failed', error)

      // Restore unsent messages back into the queue for the next poll cycle
      for (const [itemId, messages] of batchEntries) {
        const existing = this.syncBatch.get(itemId) || []
        this.syncBatch.set(itemId, [...messages, ...existing])
      }
    } finally {
      this.isPolling = false
    }
  }

  disconnect(): void {
    this.connected = false
    this.pullQueueManager.clear()
    this.stopPolling()
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

export { VAULT_PEER_ID }
