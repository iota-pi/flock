import { chunk } from 'lodash-es'

import type { KeyProvider } from '../../api/vault/Keyring'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { ItemId } from 'src/shared/vault/ids'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore'
import { SyncWriteAheadLog, type WalEntry } from './SyncWriteAheadLog'
import { decodeSyncMessage } from '@automerge/automerge/slim'
import type { DocumentId } from '@automerge/automerge-repo/slim'
import { parseBatchedMessages } from './utils/messageParser'
import { packBatchedMessages } from './utils/binaryFraming'
import { classifySyncError } from './utils/errorClassifier'
import type { PushResultItem, PollSyncBatchResponse } from '../../api/vault/SyncWorkerClient'
import { SyncApiClient } from './SyncApiClient'
import { checkAlive } from '../utils/abort'
import { SYNC_BATCH_SIZES } from '../syncConfig'
import type { RecoveryManager } from './RecoveryManager'

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'
export const MAX_CONSECUTIVE_PUSH_FAILURES = 5

export interface ChunkPushSummary {
  acknowledgedCount: number
  quarantinedCount: number
  unacknowledgedCount: number
  totalPushed: number
}

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

const POLL_CHUNK_SIZE = SYNC_BATCH_SIZES.pollChunk
const PROTOCOL_VERSION = '1.0'

export class SyncPoller {
  private account: string | null = null
  private isOnline = true
  private isShutdown = false
  private abortController: AbortController | null = null
  private readonly apiClient: SyncApiClient
  public readonly consecutivePushFailures = new Map<ItemId, number>()
  private recoveryManager: RecoveryManager | null = null

  constructor(
    private pullQueueManager: SyncPullQueueManager,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private readonly keys: KeyProvider,
    private indexManager?: AutomergeIndexManager,
    private wal?: SyncWriteAheadLog | null,
    apiClient?: SyncApiClient,
    recoveryManager?: RecoveryManager | null,
  ) {
    this.apiClient = apiClient ?? new SyncApiClient()
    this.recoveryManager = recoveryManager ?? null
  }

  setRecoveryManager(recoveryManager: RecoveryManager | null): void {
    this.recoveryManager = recoveryManager
  }

  setAccount(account: string | null): void {
    this.account = account
    this.consecutivePushFailures.clear()
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
    this.consecutivePushFailures.clear()
    this.abort()
  }

  async executePoll(): Promise<PollOutcome> {
    if (!this.isOperational) return 'no-poll'

    this.abortController = new AbortController()
    const signal = this.abortController.signal

    this.clientEventHub.emit({ type: 'startRequest' })
    const inFlightWalIds: string[] = []
    try {
      let batchEntries: ChunkEntry
      try {
        batchEntries = await this.loadWalEntries(inFlightWalIds)
      } catch (err) {
        console.error('[SyncPoller] Failed to load WAL entries', err)
        return 'failure'
      }

      const chunks = batchEntries.length > 0 ? chunk(batchEntries, POLL_CHUNK_SIZE) : [[]]

      let anyPushSucceeded = false
      let anyPushQuarantined = false
      let hadUnacknowledgedPush = false

      for (const chunkEntry of chunks) {
        const summary = await this.processChunk(chunkEntry, signal)
        if (summary.acknowledgedCount > 0) anyPushSucceeded = true
        if (summary.quarantinedCount > 0) anyPushQuarantined = true
        if (summary.unacknowledgedCount > 0) hadUnacknowledgedPush = true
      }

      // If we pushed items and EVERY pushed item failed without any item being quarantined,
      // report failure so orchestrator applies backoff between retry attempts.
      if (batchEntries.length > 0 && !anyPushSucceeded && !anyPushQuarantined && hadUnacknowledgedPush) {
        return 'failure'
      }

      await this.indexManager?.updateLastSyncTime(Date.now())
      return 'success'
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isAbort || signal.aborted || !this.isOperational) {
        return 'no-poll'
      }

      if (classified.isAuth) {
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
  ): Promise<ChunkPushSummary> {
    const sentIdsByItem = new Map<ItemId, string[]>()
    const pushMessages = await Promise.all(
      chunkEntry.map(async ([itemId, messages]) => {
        sentIdsByItem.set(
          itemId,
          messages.map(m => m.id)
        )
        const combined = packBatchedMessages(messages)
        const encryptedMessage = await this.keys.encryptBytes(combined, itemId)
        return {
          itemId,
          encryptedMessage: {
            ...encryptedMessage,
            version: PROTOCOL_VERSION,
          },
        }
      })
    )

    checkAlive(signal, () => this.isOperational)

    // Send both pullCursors (for lagging/retry-pending items that need per-item catchup)
    // and clientLatestCursor (for global updates across all other healthy items).
    const globalPageToken = this.pullQueueManager.getGlobalPageToken()
    const pullCursors = this.pullQueueManager.getCursors()
    const hasPageTokens = !!globalPageToken || pullCursors.some(c => c.pageToken)
    let response: PollSyncBatchResponse
    try {
      response = await this.apiClient.pollSyncBatch(
        {
          account: this.account!,
          pushMessages,
          pullCursors,
          clientLatestCursor: this.pullQueueManager.getGlobalScanCursor(),
          globalPageToken,
        },
        { signal }
      )
    } catch (error) {
      if (hasPageTokens && this.isRejectedRequest(error)) {
        console.warn('[SyncPoller] Server rejected a page token; restarting pagination from the cursors', error)
        this.pullQueueManager.resetPagination()
      }
      throw error
    }

    checkAlive(signal, () => this.isOperational)

    let summary: ChunkPushSummary = {
      acknowledgedCount: 0,
      quarantinedCount: 0,
      unacknowledgedCount: 0,
      totalPushed: chunkEntry.length,
    }

    if (chunkEntry.length > 0) {
      summary = await this.handlePushAcknowledgments(
        chunkEntry,
        sentIdsByItem,
        response?.pushResults
      )
    }

    await this.handlePollResponse(response)

    return summary
  }

  private async handlePushAcknowledgments(
    chunkEntry: ChunkEntry,
    sentIdsByItem: Map<ItemId, string[]>,
    pushResults?: PushResultItem[]
  ): Promise<ChunkPushSummary> {
    const acknowledgedIds: string[] = []
    const acknowledgedItemIds = new Set<ItemId>()
    const quarantinedIds: string[] = []
    const quarantinedItemIds = new Set<ItemId>()

    const results = pushResults ?? []
    for (const result of results) {
      if (this.isPushResultSuccessful(result)) {
        acknowledgedItemIds.add(result.itemId)
        this.consecutivePushFailures.delete(result.itemId)
        const ids = sentIdsByItem.get(result.itemId)
        if (ids && ids.length > 0) {
          acknowledgedIds.push(...ids)
        }
        if (typeof result.cursor === 'number' && Number.isFinite(result.cursor)) {
          this.pullQueueManager.recordOwnPushedMessage(result.itemId, result.cursor)
        }
        this.acknowledgeSuccessfulPush(chunkEntry, result)
      } else {
        console.warn(`[SyncPoller] Push failed for item ${result.itemId}`, result)
      }
    }

    for (const [sentItemId, messages] of chunkEntry) {
      if (!acknowledgedItemIds.has(sentItemId)) {
        const failures = (this.consecutivePushFailures.get(sentItemId) || 0) + 1
        const pushResult = results.find(r => r.itemId === sentItemId)
        const errorMsg = pushResult?.error || 'Push unacknowledged by server'

        if (failures >= MAX_CONSECUTIVE_PUSH_FAILURES) {
          console.error(
            `[SyncPoller] Item ${sentItemId} reached max consecutive push failures (${failures}). Quarantining to manual recovery.`
          )
          quarantinedItemIds.add(sentItemId)
          this.consecutivePushFailures.delete(sentItemId)
          for (const m of messages) {
            if (m.id) quarantinedIds.push(m.id)
          }
          if (this.recoveryManager) {
            try {
              await this.recoveryManager.quarantine(
                sentItemId,
                'pushFailure',
                `Push failed after ${MAX_CONSECUTIVE_PUSH_FAILURES} consecutive attempts: ${errorMsg}`
              )
            } catch (qErr) {
              console.error(`[SyncPoller] Failed to quarantine item ${sentItemId}:`, qErr)
            }
          }
        } else {
          this.consecutivePushFailures.set(sentItemId, failures)
          console.warn(
            `[SyncPoller] Push failed for item ${sentItemId} (attempt ${failures}/${MAX_CONSECUTIVE_PUSH_FAILURES}): ${errorMsg}, preserving in WAL`
          )
        }
      }
    }

    const idsToRemove = [...acknowledgedIds, ...quarantinedIds]
    if (this.wal && idsToRemove.length > 0) {
      try {
        await this.wal.remove(idsToRemove)
      } catch (walErr) {
        console.error('[SyncPoller] Failed to remove acknowledged/quarantined IDs from WAL', walErr)
        throw walErr
      }
    }

    return {
      acknowledgedCount: acknowledgedItemIds.size,
      quarantinedCount: quarantinedItemIds.size,
      unacknowledgedCount: chunkEntry.length - acknowledgedItemIds.size - quarantinedItemIds.size,
      totalPushed: chunkEntry.length,
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
      const hasMoreGlobal = response.globalHasMore ?? response.hasMore
      if (typeof hasMoreGlobal === 'boolean') {
        await this.pullQueueManager.processPullResults(
          response.pullResults ?? [],
          hasMoreGlobal,
          response.globalNextPageToken,
          response.globalScannedThroughCursor,
        )
      } else if (response.pullResults) {
        await this.pullQueueManager.processPullResults(response.pullResults)
      }
    } catch (pullErr) {
      console.error('[SyncPoller] Error processing pull results', pullErr)
      throw pullErr
    }
  }

  private isRejectedRequest(error: unknown): boolean {
    const classified = classifySyncError(error)
    if (classified.isAuth || classified.isAbort) return false
    return typeof classified.status === 'number' && classified.status >= 400 && classified.status < 500
  }

  private isPushResultSuccessful(result: PushResultItem): boolean {
    if (!result || !result.itemId) return false
    if (result.success === false) return false
    if (result.success === true) return true
    return typeof result.cursor === 'number' && Number.isFinite(result.cursor) && result.cursor >= 0
  }
}
