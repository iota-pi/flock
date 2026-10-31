import { chunk } from 'lodash-es'

import type { KeyProvider } from '../../api/Keyring'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { ItemId } from '@vault/shared'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SyncWriteAheadLog, type WalEntry } from './SyncWriteAheadLog'
import { decodeSyncMessage } from '@automerge/automerge/slim'
import { BATCHED_MESSAGE_VERSION, packBatchedMessages } from './utils/binaryFraming'
import { classifySyncError } from '../utils/errorClassifier'
import type { PushResultItem, PollSyncBatchResponse, SyncApiClient } from './SyncApiClient'
import { checkAlive } from '../utils/abort'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import type { RecoveryManager } from './RecoveryManager'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncPoller')

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'
const MAX_CONSECUTIVE_PUSH_FAILURES = 5

export interface ChunkPushSummary {
  acknowledgedCount: number
  quarantinedCount: number
  unacknowledgedCount: number
  totalPushed: number
}

type ChunkEntry = [ItemId, WalEntry[]][]

const POLL_CHUNK_SIZE = SYNC_BATCH_SIZES.pollChunk

export interface SyncPollerDeps {
  pullQueueManager: SyncPullQueueManager
  clientEventHub: ClientEventHub
  internalEventHub: WorkerInternalEventHub
  keys: KeyProvider
  wal: SyncWriteAheadLog
  apiClient: SyncApiClient
  recoveryManager: RecoveryManager
}

export class SyncPoller {
  private account: string | null = null
  private isOnline = true
  private isShutdown = false
  private readonly apiClient: SyncApiClient
  public readonly consecutivePushFailures = new Map<ItemId, number>()
  private readonly recoveryManager: RecoveryManager
  private readonly pullQueueManager: SyncPullQueueManager
  private readonly clientEventHub: ClientEventHub
  private readonly internalEventHub: WorkerInternalEventHub
  private readonly keys: KeyProvider
  private readonly wal: SyncWriteAheadLog
  /** WAL entries already checked to be sync messages, so a retried push doesn't decode them again */
  private validEntryIds = new Set<string>()

  constructor(deps: SyncPollerDeps) {
    this.pullQueueManager = deps.pullQueueManager
    this.clientEventHub = deps.clientEventHub
    this.internalEventHub = deps.internalEventHub
    this.keys = deps.keys
    this.wal = deps.wal
    this.apiClient = deps.apiClient
    this.recoveryManager = deps.recoveryManager
  }

  setAccount(account: string | null): void {
    this.account = account
    this.consecutivePushFailures.clear()
    if (account) {
      this.isShutdown = false
    }
  }

  setOnlineState(isOnline: boolean): void {
    this.isOnline = isOnline
  }

  get isOperational(): boolean {
    return !this.isShutdown && this.isOnline && Boolean(this.account)
  }

  shutdown(): void {
    this.isShutdown = true
    this.consecutivePushFailures.clear()
  }

  /** Pushes the WAL and pulls updates. Aborting `signal` cancels the poll, which then reports `'no-poll'`. */
  async executePoll(signal: AbortSignal = new AbortController().signal): Promise<PollOutcome> {
    if (!this.isOperational) return 'no-poll'

    this.clientEventHub.emit({ type: 'startRequest' })
    const inFlightWalIds: string[] = []
    try {
      let batchEntries: ChunkEntry
      try {
        batchEntries = await this.loadWalEntries(inFlightWalIds)
      } catch (err) {
        log.error('Failed to load WAL entries', err)
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

      return 'success'
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isAbort || signal.aborted || !this.isOperational) {
        return 'no-poll'
      }

      if (classified.isAuth) {
        log.error('Auth failure during polling', error)
        return 'auth-failure'
      }

      log.error('Polling failed', error)
      return 'failure'
    } finally {
      if (inFlightWalIds.length > 0) {
        this.wal.unmarkInFlight(inFlightWalIds)
      }
      this.clientEventHub.emit({ type: 'finishRequest' })
    }
  }

  private async loadWalEntries(inFlightWalIds: string[]): Promise<ChunkEntry> {
    const walMap = await this.wal.readAll()
    await this.dropInvalidEntries(walMap)
    const batchEntries = Array.from(walMap.entries())
    for (const [, messages] of batchEntries) {
      for (const m of messages) {
        if (m && m.id) {
          inFlightWalIds.push(m.id)
        }
      }
    }
    if (inFlightWalIds.length > 0) {
      this.wal.markInFlight(inFlightWalIds)
    }
    return batchEntries
  }

  /**
   * Drops the WAL entries of every item with an entry that isn't an Automerge sync message, so bad
   * bytes never reach other devices, and removes those items from `walMap`. The local doc holds the
   * changes (sync rule 1), so the items get a snapshot instead, as for pruning. Entries that older
   * versions' WAL compaction batched end up here too.
   */
  private async dropInvalidEntries(walMap: Map<ItemId, WalEntry[]>): Promise<void> {
    const validEntryIds = new Set<string>()
    const droppedEntryIds: string[] = []
    const droppedItemIds: ItemId[] = []
    for (const [itemId, entries] of walMap) {
      if (entries.every(entry => this.isSyncMessage(entry))) {
        for (const entry of entries) {
          validEntryIds.add(entry.id)
        }
      } else {
        droppedItemIds.push(itemId)
        droppedEntryIds.push(...entries.map(entry => entry.id))
        walMap.delete(itemId)
      }
    }
    this.validEntryIds = validEntryIds

    if (droppedItemIds.length > 0) {
      await this.wal.remove(droppedEntryIds)
      this.internalEventHub.emit({ type: 'walEntriesPruned', itemIds: droppedItemIds })
    }
  }

  private isSyncMessage(entry: WalEntry): boolean {
    if (this.validEntryIds.has(entry.id)) return true
    try {
      decodeSyncMessage(entry.data)
      return true
    } catch (error) {
      // An error, not a warning: the snapshot heals the item, so this is the only sign of whatever wrote the entry
      log.error(`WAL entry ${entry.id} for ${entry.itemId} isn't a sync message; dropping the item's entries for a snapshot`, error)
      return false
    }
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
        const combined = packBatchedMessages(messages.map(m => m.data))
        const encryptedMessage = await this.keys.encryptBytes(combined, itemId)
        return {
          itemId,
          encryptedMessage: {
            ...encryptedMessage,
            version: BATCHED_MESSAGE_VERSION,
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
        log.warn('Server rejected a page token; restarting pagination from the cursors', error)
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
        response.pushResults
      )
    }

    await this.handlePollResponse(response)

    return summary
  }

  private async handlePushAcknowledgments(
    chunkEntry: ChunkEntry,
    sentIdsByItem: Map<ItemId, string[]>,
    results: PushResultItem[]
  ): Promise<ChunkPushSummary> {
    const acknowledgedIds: string[] = []
    const acknowledgedItemIds = new Set<ItemId>()
    const quarantinedIds: string[] = []
    const quarantinedItemIds = new Set<ItemId>()

    for (const result of results) {
      if (this.isPushResultSuccessful(result)) {
        acknowledgedItemIds.add(result.itemId)
        this.consecutivePushFailures.delete(result.itemId)
        const ids = sentIdsByItem.get(result.itemId)
        if (ids && ids.length > 0) {
          acknowledgedIds.push(...ids)
        }
        this.pullQueueManager.recordOwnPushedMessage(result.itemId, result.cursor)
        this.acknowledgeSuccessfulPush(chunkEntry, result)
      } else {
        log.warn(`Push failed for item ${result.itemId}`, result)
      }
    }

    for (const [sentItemId, messages] of chunkEntry) {
      if (!acknowledgedItemIds.has(sentItemId)) {
        const failures = (this.consecutivePushFailures.get(sentItemId) || 0) + 1
        const errorMsg = 'Push unacknowledged by server'

        if (failures >= MAX_CONSECUTIVE_PUSH_FAILURES) {
          log.error(
            `Item ${sentItemId} reached max consecutive push failures (${failures}). Quarantining to manual recovery.`
          )
          quarantinedItemIds.add(sentItemId)
          this.consecutivePushFailures.delete(sentItemId)
          for (const m of messages) {
            if (m.id) quarantinedIds.push(m.id)
          }
          try {
            await this.recoveryManager.quarantine(
              sentItemId,
              'pushFailure',
              `Push failed after ${MAX_CONSECUTIVE_PUSH_FAILURES} consecutive attempts: ${errorMsg}`
            )
          } catch (qErr) {
            log.error(`Failed to quarantine item ${sentItemId}:`, qErr)
          }
        } else {
          this.consecutivePushFailures.set(sentItemId, failures)
          log.warn(
            `Push failed for item ${sentItemId} (attempt ${failures}/${MAX_CONSECUTIVE_PUSH_FAILURES}): ${errorMsg}, preserving in WAL`
          )
        }
      }
    }

    const idsToRemove = [...acknowledgedIds, ...quarantinedIds]
    if (idsToRemove.length > 0) {
      try {
        await this.wal.remove(idsToRemove)
      } catch (walErr) {
        log.error('Failed to remove acknowledged/quarantined IDs from WAL', walErr)
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

    try {
      const decoded = decodeSyncMessage(lastEntry.data)
      if (decoded.heads && decoded.heads.length > 0) {
        this.internalEventHub.emit({
          type: 'pushAcknowledged',
          itemId: result.itemId,
          heads: decoded.heads,
        })
      }
    } catch (err) {
      log.warn('Failed to decode acknowledged sync message', err)
    }
  }

  private async handlePollResponse(response: PollSyncBatchResponse): Promise<void> {
    try {
      await this.pullQueueManager.processPullResults(
        response.pullResults,
        response.globalHasMore,
        response.globalNextPageToken,
        response.globalScannedThroughCursor,
      )
    } catch (pullErr) {
      log.error('Error processing pull results', pullErr)
      throw pullErr
    }
  }

  /** Whether the server turned the request itself down. Timeouts (408) and rate limits (429) don't count. */
  private isRejectedRequest(error: unknown): boolean {
    const classified = classifySyncError(error)
    if (classified.isAuth || classified.isAbort || classified.isNetwork) return false
    return typeof classified.status === 'number' && classified.status >= 400 && classified.status < 500
  }

  private isPushResultSuccessful(result: PushResultItem): boolean {
    return Number.isFinite(result.cursor) && result.cursor >= 0
  }
}
