import { chunk } from 'lodash-es'

import { encryptBytes } from '../../api/vault'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { ItemId } from 'src/shared/schemas/items'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncWriteAheadLog, type WalEntry } from './SyncWriteAheadLog'
import { decodeSyncMessage } from '@automerge/automerge/slim'
import type { DocumentId } from '@automerge/automerge-repo/slim'
import { parseBatchedMessages } from './utils/messageParser'
import { packBatchedMessages } from './utils/binaryFraming'
import { isAuthError } from './utils/auth'
import type { PushResultItem, PollSyncBatchResponse } from '../../api/vault/SyncWorkerClient'
import { SyncApiClient } from './SyncApiClient'
import { checkAlive, isAbortError } from './utils/abort'

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'
type ChunkEntry = [ItemId, WalEntry[]][]

function extractLastSyncMessage(entry: WalEntry): Uint8Array | null {
  if (!entry || !entry.data || entry.data.byteLength === 0) return null
  if (!entry.isBatched) return entry.data
  let last: Uint8Array | null = null
  parseBatchedMessages(entry.itemId, '' as DocumentId, entry.data, (_itemId, _docId, msg) => {
    last = msg
  })
  return last
}

const POLL_CHUNK_SIZE = 5
const PROTOCOL_VERSION = '1.0'

export class SyncPoller {
  private account: string | null = null
  private isOnline = true
  private isShutdown = false
  private abortController: AbortController | null = null
  private readonly apiClient: SyncApiClient

  constructor(
    private pullQueueManager: SyncPullQueueManager,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private indexManager?: AutomergeIndexManager,
    private wal?: SyncWriteAheadLog | null,
    apiClient?: SyncApiClient,
  ) {
    this.apiClient = apiClient ?? new SyncApiClient()
  }

  setAccount(account: string | null): void {
    this.account = account
    if (account) {
      this.isShutdown = false
    }
  }

  setWal(wal: SyncWriteAheadLog | null): void {
    this.wal = wal
  }

  setOnlineState(isOnline: boolean): void {
    this.isOnline = isOnline
  }

  get isOperational(): boolean {
    return !this.isShutdown && this.isOnline && Boolean(this.account)
  }

  isCurrentlyPolling(): boolean {
    return this.abortController !== null
  }

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  shutdown(): void {
    this.isShutdown = true
    this.abort()
  }

  async executePoll(): Promise<PollOutcome> {
    if (!this.isOperational) return 'no-poll'

    this.abortController = new AbortController()
    const signal = this.abortController.signal

    this.clientEventHub.emit({ type: 'startRequest' })
    const inFlightWalIds: string[] = []
    try {
      const hasToken = await this.apiClient.hasAuthToken()
      if (!hasToken) return 'no-poll'

      let batchEntries: ChunkEntry
      try {
        batchEntries = await this.loadWalEntries(inFlightWalIds)
      } catch (err) {
        console.error('[SyncPoller] Failed to load WAL entries', err)
        return 'failure'
      }

      const chunks = batchEntries.length > 0 ? chunk(batchEntries, POLL_CHUNK_SIZE) : [[]]

      for (const chunkEntry of chunks) {
        await this.processChunk(chunkEntry, signal)
      }

      await this.indexManager?.updateLastSyncTime(Date.now())
      return 'success'
    } catch (error) {
      if (isAbortError(error) || signal.aborted || !this.isOperational) {
        return 'no-poll'
      }

      if (this.isAuthError(error)) {
        console.error('[SyncPoller] Auth failure during polling', error)
        return 'auth-failure'
      }

      console.error('[SyncPoller] Polling failed', error)
      return 'failure'
    } finally {
      this.abortController = null
      if (this.wal && inFlightWalIds.length > 0) {
        this.wal.unmarkInFlight?.(inFlightWalIds)
      }
      this.clientEventHub.emit({ type: 'finishRequest' })
    }
  }

  private async loadWalEntries(inFlightWalIds: string[]): Promise<ChunkEntry> {
    if (!this.wal) return []
    const walMap = await this.wal.readAll()
    const batchEntries = Array.from(walMap.entries())
    for (const [, messages] of batchEntries) {
      for (const m of messages) {
        if (m && m.id) {
          inFlightWalIds.push(m.id)
        }
      }
    }
    if (inFlightWalIds.length > 0) {
      this.wal.markInFlight?.(inFlightWalIds)
    }
    return batchEntries
  }

  private async processChunk(
    chunkEntry: ChunkEntry,
    signal: AbortSignal
  ): Promise<void> {
    const sentIdsByItem = new Map<ItemId, string[]>()
    const pushMessages = await Promise.all(
      chunkEntry.map(async ([itemId, messages]) => {
        sentIdsByItem.set(
          itemId,
          messages.map(m => m.id)
        )
        const combined = packBatchedMessages(messages)
        const encryptedMessage = await encryptBytes(combined)
        return {
          itemId,
          encryptedMessage: {
            iv: encryptedMessage.iv,
            cipher: encryptedMessage.cipher,
            kver: encryptedMessage.kver,
            version: PROTOCOL_VERSION,
          },
        }
      })
    )

    checkAlive(signal, () => this.isOperational)

    // Send both pullCursors (for lagging/retry-pending items that need per-item catchup)
    // and clientLatestCursor (for global updates across all other healthy items).
    const response = await this.apiClient.pollSyncBatch(
      {
        account: this.account!,
        pushMessages,
        pullCursors: this.pullQueueManager.getCursors(),
        clientLatestCursor: this.pullQueueManager.getGlobalLatestCursor(),
        globalLastEvaluatedKey: this.pullQueueManager.getGlobalLastEvaluatedKey(),
      },
      { signal }
    )

    checkAlive(signal, () => this.isOperational)

    if (chunkEntry.length > 0) {
      await this.handlePushAcknowledgments(chunkEntry, sentIdsByItem, response?.pushResults)
    }

    await this.handlePollResponse(response)
  }

  private async handlePushAcknowledgments(
    chunkEntry: ChunkEntry,
    sentIdsByItem: Map<ItemId, string[]>,
    pushResults?: PushResultItem[]
  ): Promise<void> {
    const acknowledgedIds: string[] = []
    const acknowledgedItemIds = new Set<ItemId>()

    const results = pushResults ?? []
    for (const result of results) {
      if (this.isPushResultSuccessful(result)) {
        acknowledgedItemIds.add(result.itemId)
        const ids = sentIdsByItem.get(result.itemId)
        if (ids && ids.length > 0) {
          acknowledgedIds.push(...ids)
        }
        this.acknowledgeSuccessfulPush(chunkEntry, result)
      } else {
        console.warn(`[SyncPoller] Push failed for item ${result.itemId}`, result)
      }
    }

    for (const [sentItemId] of chunkEntry) {
      if (!acknowledgedItemIds.has(sentItemId)) {
        console.warn(`[SyncPoller] Item ${sentItemId} was not acknowledged in pushResults, preserving in WAL`)
      }
    }

    if (this.wal && acknowledgedIds.length > 0) {
      try {
        await this.wal.remove(acknowledgedIds)
      } catch (walErr) {
        console.error('[SyncPoller] Failed to remove acknowledged IDs from WAL', walErr)
      }
    }
  }

  private acknowledgeSuccessfulPush(chunkEntry: ChunkEntry, result: PushResultItem): void {
    const itemMessages = chunkEntry.find(([id]) => id === result.itemId)?.[1]
    const lastEntry = itemMessages?.[itemMessages.length - 1]
    if (!lastEntry) return
    const rawMsg = extractLastSyncMessage(lastEntry)
    if (!rawMsg) return

    try {
      const decoded = decodeSyncMessage(rawMsg)
      if (decoded.heads && decoded.heads.length > 0) {
        this.internalEventHub.emit({
          type: 'pushAcknowledged',
          itemId: result.itemId,
          heads: decoded.heads,
        })
      }
    } catch (err) {
      console.warn('[SyncPoller] Failed to decode acknowledged sync message', err)
    }
  }

  private async handlePollResponse(
    response: PollSyncBatchResponse | null | undefined
  ): Promise<void> {
    if (!response) return

    try {
      if (typeof response.hasMore === 'boolean') {
        await this.pullQueueManager.processPullResults(
          response.pullResults ?? [],
          response.hasMore,
          response.globalLastEvaluatedKey
        )
      } else if (response.pullResults) {
        await this.pullQueueManager.processPullResults(response.pullResults)
      }
    } catch (pullErr) {
      console.error('[SyncPoller] Error processing pull results', pullErr)
    }
  }

  private isAuthError(error: unknown): boolean {
    return isAuthError(error)
  }

  private isPushResultSuccessful(result: PushResultItem): boolean {
    if (!result || !result.itemId) return false
    if (result.success === false) return false
    if (result.success === true) return true
    return typeof result.cursor === 'number' && Number.isFinite(result.cursor) && result.cursor >= 0
  }
}
