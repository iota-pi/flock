import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from './SyncApiClient'
import type { KeyProvider } from '../../api/Keyring'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import type { RealtimeBus } from './realtimeBus'
import type { SyncSessionState } from './SyncSessionState'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { classifySyncError } from '../utils/errorClassifier'
import { ItemId } from '@vault/shared'
import type { PageToken } from '@vault/shared'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'
import type { ItemLockCoordinator } from './docStore'
import { PullRetryTracker, type PullFailure } from './PullRetryTracker'
import type { WorkerInternalEventHub } from './SyncEventHub'
import type { VaultNetworkAdapter } from './VaultNetworkAdapter'
import { BoundedMap } from '../utils/BoundedMap'
import { BoundedSet } from '../utils/BoundedSet'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncPullQueueManager')

interface ProcessItemMessagesResult {
  highestCursor: number
  /** Why processing stopped before the last message, if it did */
  failure?: PullFailure
  hasParsedMessages: boolean
  hasParsedRemoteMessages: boolean
}

type HandledMessageEntry =
  | { parsed: true; cursor: number }
  | { parsed: false; missingKey?: boolean; kver?: string }

const BATCH_PROGRESS_CACHE_MAX = 500
const OWN_PUSH_CACHE_MAX = 1000
const KEY_WAIT_TIMEOUT_MS = SYNC_TIMEOUTS.keyWait

export interface SyncPullQueueManagerDeps {
  /** The account's stored cursors */
  cursorStore: CursorStore
  keys: KeyProvider
  lockCoordinator: ItemLockCoordinator
  internalEventHub: WorkerInternalEventHub
  /** Receives each pulled sync message */
  adapter: Pick<VaultNetworkAdapter, 'receiveServerMessage'>
  session: SyncSessionState
  /** Tells the account's other tabs which items were pulled */
  bus?: RealtimeBus
  onKeyVersionMissing?: (kver: string) => void
  /** Called with each item a message was pulled for, before the adapter receives the message */
  onItemMessageParsed?: (itemId: ItemId) => void
  /** Asks the orchestrator to poll, once pulls held back for a missing key can go ahead */
  onFlushNeeded?: () => void
}

export class SyncPullQueueManager {
  private readonly cursorStore: CursorStore
  private readonly keys: KeyProvider
  private readonly lockCoordinator: ItemLockCoordinator
  private readonly internalEventHub: WorkerInternalEventHub
  private readonly adapter: Pick<VaultNetworkAdapter, 'receiveServerMessage'>
  private readonly session: SyncSessionState
  private readonly bus: RealtimeBus | null
  private readonly onKeyVersionMissing?: (kver: string) => void
  private readonly onItemMessageParsed?: (itemId: ItemId) => void
  private readonly onFlushNeeded?: () => void

  private readonly retryTracker: PullRetryTracker
  private hasMoreGlobal = false
  private globalPageToken?: PageToken

  /** For each item, how many messages of each partly applied batch (by cursor) have been applied */
  private readonly batchProgress = new BoundedMap<ItemId, Map<number, number>>(BATCH_PROGRESS_CACHE_MAX)
  // "itemId:cursor" of messages this device pushed, so their server echoes aren't mistaken for remote edits
  private readonly ownPushedMessageKeys = new BoundedSet<string>(OWN_PUSH_CACHE_MAX)

  // A pull that finishes after shutdown mustn't save, since shutdown may be clearing local data
  private readonly saveCursorsDebounced = debounce(() => {
    if (this.session.isShutdown) return
    fireAndForget(this.persistCursors(), 'SyncPullQueueManager:persistCursors')
  }, 1000)

  constructor(deps: SyncPullQueueManagerDeps) {
    this.cursorStore = deps.cursorStore
    this.keys = deps.keys
    this.lockCoordinator = deps.lockCoordinator
    this.internalEventHub = deps.internalEventHub
    this.adapter = deps.adapter
    this.session = deps.session
    this.bus = deps.bus ?? null
    this.onKeyVersionMissing = deps.onKeyVersionMissing
    this.onItemMessageParsed = deps.onItemMessageParsed
    this.onFlushNeeded = deps.onFlushNeeded
    this.retryTracker = new PullRetryTracker(deps.keys)
  }

  private makeOwnPushKey(itemId: ItemId, cursor: number): string {
    return `${itemId}:${cursor}`
  }

  recordOwnPushedMessage(itemId: ItemId, cursor: number): void {
    this.ownPushedMessageKeys.add(this.makeOwnPushKey(itemId, cursor))
  }

  private getBatchProgress(itemId: ItemId, cursor: number): number {
    return this.batchProgress.get(itemId)?.get(cursor) ?? 0
  }

  private setBatchProgress(itemId: ItemId, cursor: number, count: number): void {
    const progress = this.batchProgress.get(itemId)
    if (progress) {
      progress.set(cursor, count)
    } else {
      this.batchProgress.set(itemId, new Map([[cursor, count]]))
    }
  }

  private clearBatchProgress(itemId: ItemId, cursor: number): void {
    const progress = this.batchProgress.get(itemId)
    progress?.delete(cursor)
    if (progress?.size === 0) {
      this.batchProgress.delete(itemId)
    }
  }

  private clearBatchProgressUpTo(itemId: ItemId, cursor: number): void {
    const progress = this.batchProgress.get(itemId)
    if (!progress) return
    for (const entryCursor of progress.keys()) {
      if (entryCursor <= cursor) {
        progress.delete(entryCursor)
      }
    }
    if (progress.size === 0) {
      this.batchProgress.delete(itemId)
    }
  }

  /** Drops the per-item pull state held in memory. The persisted cursors are left alone. */
  private clearPullState(): void {
    this.retryTracker.clear()
    this.batchProgress.clear()
    this.ownPushedMessageKeys.clear()
  }

  async loadCursors(): Promise<void> {
    if (this.session.isShutdown) return
    try {
      const stored = await this.cursorStore.loadCursors()
      if (stored) {
        this.retryTracker.loadState(stored)
      }
    } catch (error) {
      log.error('Failed to load cursors', error)
    }
  }

  async persistCursors(): Promise<void> {
    const data = this.retryTracker.exportState()
    try {
      await this.cursorStore.saveCursors(data)
    } catch (error) {
      log.error('Failed to save cursors', error)
    }
  }

  /** Saves the cursors, unless local data is being cleared. Called once, by the context's lifecycle. */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.saveCursorsDebounced.cancel()
    if (!options?.clearLocalData) {
      await this.persistCursors()
    }
    this.clearPullState()
    this.hasMoreGlobal = false
  }

  addPendingItem(itemId: ItemId): void {
    this.retryTracker.addPendingItem(itemId)
  }

  /** Hands a pulled message to the adapter. If the adapter throws, the batch stops there and is retried. */
  private deliverMessage(itemId: ItemId, documentId: DocumentId, message: Uint8Array): void {
    this.onItemMessageParsed?.(itemId)
    this.adapter.receiveServerMessage(documentId, message)
  }

  private async handleMessageEntry(
    itemId: ItemId,
    documentId: DocumentId,
    entry: PullSyncMessagesResponse['messages'][number],
    timedOutKeys?: Set<string>,
  ): Promise<HandledMessageEntry> {
    if (!entry.encryptedMessage?.iv || !entry.encryptedMessage?.cipher) {
      return { parsed: false }
    }

    let decrypted: Uint8Array
    try {
      decrypted = await decryptWithKeyResolution(this.keys, entry.encryptedMessage, {
        docId: itemId,
        timeoutMs: KEY_WAIT_TIMEOUT_MS,
        timedOutKeys,
        onKeyVersionMissing: this.onKeyVersionMissing,
      })
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isMissingKey) {
        return { parsed: false, missingKey: true, kver: classified.kver }
      }
      return { parsed: false }
    }

    // Every push since 2026-05-19 is a batch packed by packBatchedMessages, and the 90-day TTL has
    // expired anything older
    const success = parseBatchedMessages(
      decrypted,
      msg => this.deliverMessage(itemId, documentId, msg),
      {
        startIndex: this.getBatchProgress(itemId, entry.cursor),
        onMessageSuccess: index => {
          this.setBatchProgress(itemId, entry.cursor, index + 1)
        },
      }
    )
    if (!success) {
      return { parsed: false }
    }

    return { parsed: true, cursor: entry.cursor }
  }

  getCursors(): Array<{ itemId: ItemId; cursor: number; pageToken?: PageToken }> {
    return this.retryTracker.getCursors()
  }

  hasImmediatePendingPulls(): boolean {
    if (this.hasMoreGlobal) {
      return true
    }
    return this.retryTracker.hasImmediatePendingPulls()
  }

  onKeyringUpdated(): void {
    const unblockedAny = this.retryTracker.onKeyringUpdated()
    if (unblockedAny) {
      const isRetrying = this.retryTracker.isAnyRetrying()
      this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying })
      this.onFlushNeeded?.()
    }
  }

  getGlobalLatestCursor(): number {
    return this.retryTracker.getGlobalLatestCursor()
  }

  getGlobalScanCursor(): number {
    return this.retryTracker.getGlobalScanCursor()
  }

  /**
   * Abandons in-progress paginations after the server rejected a page token: the next poll
   * restarts the account-wide scan from the persisted scan cursor, and pending items continue
   * from their cursors.
   */
  resetPagination(): void {
    this.hasMoreGlobal = false
    this.globalPageToken = undefined
    this.retryTracker.clearPageTokens()
  }

  getGlobalPageToken(): PageToken | undefined {
    return this.hasMoreGlobal ? this.globalPageToken : undefined
  }

  private async processItemMessages(
    itemId: ItemId,
    messages: PullSyncMessagesResponse['messages'] | undefined,
    initialCursor: number,
    timedOutKeys: Set<string>
  ): Promise<ProcessItemMessagesResult> {
    const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

    // Sort messages ascending by cursor to ensure causal processing order and prevent
    // out-of-order cursors from prematurely advancing state.cursor if an earlier cursor fails.
    const sortedMessages = [...(messages || [])].sort((a, b) => a.cursor - b.cursor)

    if (sortedMessages.length === 0) {
      return { highestCursor: initialCursor, hasParsedMessages: false, hasParsedRemoteMessages: false }
    }

    return this.lockCoordinator.withItemLock(itemId, async () => {
      let highestCursor = initialCursor
      let failure: PullFailure | undefined
      let hasParsedMessages = false
      let hasParsedRemoteMessages = false

      for (const entry of sortedMessages) {
        if (entry.cursor <= initialCursor) {
          this.clearBatchProgress(itemId, entry.cursor)
          highestCursor = Math.max(highestCursor, entry.cursor)
          continue
        }

        const handled = await this.handleMessageEntry(itemId, documentId, entry, timedOutKeys)
        if (handled.parsed) {
          hasParsedMessages = true
          const ownKey = this.makeOwnPushKey(itemId, handled.cursor)
          if (!this.ownPushedMessageKeys.has(ownKey)) {
            hasParsedRemoteMessages = true
          }
          this.ownPushedMessageKeys.delete(ownKey)
          this.clearBatchProgress(itemId, handled.cursor)
          highestCursor = Math.max(highestCursor, handled.cursor)
        } else if (handled.missingKey) {
          failure = { kind: 'keyMissing', kver: handled.kver }
          break
        } else {
          failure = { kind: 'parseFailure', cursor: entry.cursor }
          break
        }
      }

      return { highestCursor, failure, hasParsedMessages, hasParsedRemoteMessages }
    })
  }

  private async processSinglePullResult(
    result: PullSyncMessagesResponse,
    timedOutKeys: Set<string>,
  ): Promise<{ itemId: ItemId; hasParsedMessages: boolean; cursorUpdated: boolean }> {
    const itemId = result.itemId
    const hasMore = result.hasMore === true
    const isNewItem = !this.retryTracker.hasState(itemId)
    const initialCursor = this.retryTracker.getCursor(itemId)

    const messageResult = await this.processItemMessages(
      itemId,
      result.messages,
      initialCursor,
      timedOutKeys
    )

    const { failure } = messageResult
    let highestCursor = messageResult.highestCursor
    if (!failure && Number.isFinite(result.nextCursor)) {
      highestCursor = Math.max(highestCursor, result.nextCursor)
    }

    const outcome = this.retryTracker.recordPullOutcome({
      itemId,
      highestCursor,
      isNewItem,
      failure,
      hasMore,
      nextCursor: result.nextCursor,
      pageToken: result.nextPageToken,
    })

    if (highestCursor > initialCursor) {
      this.clearBatchProgressUpTo(itemId, highestCursor)
    }

    if (outcome.permanentlyFailed || (!failure && !hasMore)) {
      this.batchProgress.delete(itemId)
    }

    if (messageResult.hasParsedRemoteMessages && !failure && !outcome.permanentlyFailed) {
      this.internalEventHub.emit({ type: 'remoteMessagesParsed', itemId })
    }

    if (outcome.permanentlyFailed) {
      const err = new Error(
        `Permanently failed to parse sync messages after ${PullRetryTracker.MAX_PULL_RETRIES} attempts`
      )
      this.internalEventHub.emit({ type: 'decryptionFailure', itemId, error: err })
    }

    return {
      itemId,
      hasParsedMessages: messageResult.hasParsedMessages,
      cursorUpdated: outcome.cursorUpdated,
    }
  }

  /**
   * @param globalScannedThroughCursor Global scan position reported by the server. Only it advances
   * the global cursor; per-item results (which may run ahead of the scan) never do.
   */
  async processPullResults(
    results: PullSyncMessagesResponse[],
    hasMoreGlobal: boolean,
    globalNextPageToken: PageToken | undefined,
    globalScannedThroughCursor: number | undefined,
  ): Promise<void> {
    if (this.session.isShutdown) return
    this.hasMoreGlobal = hasMoreGlobal
    this.globalPageToken = hasMoreGlobal ? globalNextPageToken : undefined

    const successfullyPulledItemIds = new Set<ItemId>()
    let cursorsUpdated = false
    const timedOutKeys = new Set<string>()
    // One bad item must not block the others, but the poll must still report failure
    // (sync rule 4), so the first per-item error is re-thrown after the loop.
    let firstItemError: { error: unknown } | undefined

    try {
      for (const result of results || []) {
        try {
          const itemOutcome = await this.processSinglePullResult(result, timedOutKeys)
          if (itemOutcome.hasParsedMessages) {
            successfullyPulledItemIds.add(itemOutcome.itemId)
          }
          if (itemOutcome.cursorUpdated) {
            cursorsUpdated = true
          }
        } catch (innerError) {
          log.error(`Pull sync failed for item: ${result.itemId}`, innerError)
          firstItemError ??= { error: innerError }
        }
      }

      if (typeof globalScannedThroughCursor === 'number') {
        const previous = this.retryTracker.getGlobalScanCursor()
        this.retryTracker.setGlobalCursor(globalScannedThroughCursor)
        if (this.retryTracker.getGlobalScanCursor() !== previous) {
          cursorsUpdated = true
        }
      }

      if (cursorsUpdated) {
        this.saveCursorsDebounced()
      }

      if (firstItemError) {
        throw firstItemError.error
      }
    } finally {
      const isRetrying = this.retryTracker.isAnyRetrying()
      this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying })
      if (successfullyPulledItemIds.size > 0) {
        this.bus?.publishSyncPing(Array.from(successfullyPulledItemIds))
      }
    }
  }

  exportCursors(): [ItemId, number][] {
    return this.retryTracker.exportCursors()
  }

  async importCursors(cursors: [ItemId, number][]): Promise<void> {
    this.retryTracker.importCursors(cursors)
    for (const [itemId, cursor] of cursors) {
      this.clearBatchProgressUpTo(itemId, cursor)
    }
    await this.cursorStore.saveCursors(this.retryTracker.exportState())
  }
}
