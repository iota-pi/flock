import { chunk } from 'lodash-es'

import type { KeyProvider } from '../keys/Keyring'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import type { ItemId } from '@vault/shared'
import type { SyncSessionState } from './SyncSessionState'
import type { SyncWriteAheadLog, WalEntry } from './SyncWriteAheadLog'
import { decodeSyncMessage } from '@automerge/automerge/slim'
import { BATCHED_MESSAGE_VERSION, packBatchedMessages } from './utils/binaryFraming'
import { classifySyncError } from '../utils/errorClassifier'
import type { PushResultItem, PollSyncBatchResponse, SyncApiClient } from './SyncApiClient'
import { checkAlive } from '../utils/abort'
import { SYNC_BATCH_SIZES } from '../shared/syncConfig'
import type { RecoveryManager } from './RecoveryManager'
import { createLogger } from '../utils/logger'
import { ConsecutiveFailureCounter } from '../utils/ConsecutiveFailureCounter'

const log = createLogger('SyncPoller')

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'
const MAX_CONSECUTIVE_PUSH_FAILURES = 5

export interface ChunkPushSummary {
  acknowledgedCount: number
  quarantinedCount: number
  unacknowledgedCount: number
}

type ChunkEntry = [ItemId, WalEntry[]][]

const POLL_CHUNK_SIZE = SYNC_BATCH_SIZES.pollChunk

export interface SyncPollerDeps {
  accountId: string
  session: SyncSessionState
  pullQueueManager: SyncPullQueueManager
  keys: KeyProvider
  wal: SyncWriteAheadLog
  apiClient: SyncApiClient
  recoveryManager: RecoveryManager
  /** Receives the heads of each item the server accepted a push for */
  onPushAcknowledged: (itemId: ItemId, heads: string[]) => void
  /** Called with the items whose WAL entries were dropped, which only a snapshot can now deliver */
  onWalEntriesPruned?: (itemIds: ItemId[]) => void
}

export class SyncPoller {
  private readonly consecutivePushFailures = new ConsecutiveFailureCounter<ItemId>(MAX_CONSECUTIVE_PUSH_FAILURES)
  /** WAL entries already checked to be sync messages, so a retried push doesn't decode them again */
  private validEntryIds = new Set<string>()

  constructor(private readonly deps: SyncPollerDeps) {}

  private get isOperational(): boolean {
    return this.deps.session.isOperational
  }

  shutdown(): void {
    this.consecutivePushFailures.clear()
  }

  /**
   * Pushes the WAL and pulls updates. Aborting `signal` cancels the poll, which then reports `'no-poll'`.
   * Polls go through the untracked client, so they don't show as activity in the sync status.
   */
  async executePoll(signal: AbortSignal = new AbortController().signal): Promise<PollOutcome> {
    if (!this.isOperational) return 'no-poll'

    const inFlightWalIds: string[] = []
    try {
      const batchEntries = await this.loadWalEntries(inFlightWalIds)

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
        this.deps.wal.unmarkInFlight(inFlightWalIds)
      }
    }
  }

  private async loadWalEntries(inFlightWalIds: string[]): Promise<ChunkEntry> {
    const walMap = await this.deps.wal.readAll()
    await this.dropInvalidEntries(walMap)
    const batchEntries = Array.from(walMap.entries())
    for (const [, messages] of batchEntries) {
      inFlightWalIds.push(...messages.map(m => m.id))
    }
    if (inFlightWalIds.length > 0) {
      this.deps.wal.markInFlight(inFlightWalIds)
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
      await this.deps.wal.remove(droppedEntryIds)
      this.deps.onWalEntriesPruned?.(droppedItemIds)
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
        const encryptedMessage = await this.deps.keys.encryptBytes(combined, itemId)
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
    const globalPageToken = this.deps.pullQueueManager.getGlobalPageToken()
    const pullCursors = this.deps.pullQueueManager.cursors.getPendingPulls()
    const hasPageTokens = !!globalPageToken || pullCursors.some(c => c.pageToken)
    let response: PollSyncBatchResponse
    try {
      response = await this.deps.apiClient.pollSyncBatch(
        {
          account: this.deps.accountId,
          pushMessages,
          pullCursors,
          clientLatestCursor: this.deps.pullQueueManager.cursors.getGlobalScanCursor(),
          globalPageToken,
        },
        { signal }
      )
    } catch (error) {
      if (hasPageTokens && this.isRejectedRequest(error)) {
        log.warn('Server rejected a page token; restarting pagination from the cursors', error)
        this.deps.pullQueueManager.resetPagination()
      }
      throw error
    }

    checkAlive(signal, () => this.isOperational)

    let summary: ChunkPushSummary = {
      acknowledgedCount: 0,
      quarantinedCount: 0,
      unacknowledgedCount: 0,
    }

    if (chunkEntry.length > 0) {
      summary = await this.handlePushAcknowledgments(
        chunkEntry,
        sentIdsByItem,
        response.pushResults
      )
    }

    await this.deps.pullQueueManager.processPullResults(
      response.pullResults,
      response.globalHasMore,
      response.globalNextPageToken,
      response.globalScannedThroughCursor,
    )

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
        this.consecutivePushFailures.reset(result.itemId)
        const ids = sentIdsByItem.get(result.itemId)
        if (ids && ids.length > 0) {
          acknowledgedIds.push(...ids)
        }
        this.deps.pullQueueManager.recordOwnPushedMessage(result.itemId, result.cursor)
        this.acknowledgeSuccessfulPush(chunkEntry, result)
      } else {
        log.warn(`Push failed for item ${result.itemId}`, result)
      }
    }

    for (const [sentItemId, messages] of chunkEntry) {
      if (!acknowledgedItemIds.has(sentItemId)) {
        const exhausted = this.consecutivePushFailures.recordFailure(sentItemId)
        const errorMsg = 'Push unacknowledged by server'

        if (exhausted) {
          log.error(
            `Item ${sentItemId} reached max consecutive push failures (${MAX_CONSECUTIVE_PUSH_FAILURES}). Quarantining to manual recovery.`
          )
          quarantinedItemIds.add(sentItemId)
          quarantinedIds.push(...messages.map(m => m.id))
          try {
            await this.deps.recoveryManager.quarantine(
              sentItemId,
              'pushFailure',
              `Push failed after ${MAX_CONSECUTIVE_PUSH_FAILURES} consecutive attempts: ${errorMsg}`
            )
          } catch (qErr) {
            log.error(`Failed to quarantine item ${sentItemId}:`, qErr)
          }
        } else {
          log.warn(
            `Push failed for item ${sentItemId} (attempt ${this.consecutivePushFailures.count(sentItemId)}/${MAX_CONSECUTIVE_PUSH_FAILURES}): ${errorMsg}, preserving in WAL`
          )
        }
      }
    }

    const idsToRemove = [...acknowledgedIds, ...quarantinedIds]
    if (idsToRemove.length > 0) {
      await this.deps.wal.remove(idsToRemove)
    }

    return {
      acknowledgedCount: acknowledgedItemIds.size,
      quarantinedCount: quarantinedItemIds.size,
      unacknowledgedCount: chunkEntry.length - acknowledgedItemIds.size - quarantinedItemIds.size,
    }
  }

  private acknowledgeSuccessfulPush(chunkEntry: ChunkEntry, result: PushResultItem): void {
    const itemMessages = chunkEntry.find(([id]) => id === result.itemId)?.[1]
    const lastEntry = itemMessages?.[itemMessages.length - 1]
    if (!lastEntry) return

    let heads: string[]
    try {
      heads = decodeSyncMessage(lastEntry.data).heads
    } catch (err) {
      log.warn('Failed to decode acknowledged sync message', err)
      return
    }
    if (heads && heads.length > 0) {
      this.deps.onPushAcknowledged(result.itemId, heads)
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
