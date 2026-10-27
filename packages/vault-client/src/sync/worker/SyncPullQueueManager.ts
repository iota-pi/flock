import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from './SyncWorkerClient'
import type { KeyProvider } from '../../api/Keyring'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { classifySyncError } from '../utils/errorClassifier'
import { ItemId } from '@vault/shared'
import type { PageToken } from '@vault/shared'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'
import { BATCHED_MESSAGE_VERSION } from './utils/binaryFraming'
import type { ItemLockCoordinator } from './docStore'
import { PullRetryTracker } from './PullRetryTracker'
import type { WorkerInternalEventHub } from './SyncEventHub'
import { BoundedMap } from '../utils/BoundedMap'
import { BoundedSet } from '../utils/BoundedSet'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import type { LifecycleAware } from './ServiceLifecycleManager'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncPullQueueManager')

interface ProcessItemMessagesResult {
  highestCursor: number
  hasParseFailure: boolean
  hasKeyFailure: boolean
  blockedOnKey?: string
  failingCursor?: number
  hasParsedMessages: boolean
  hasParsedRemoteMessages: boolean
}

type HandledMessageEntry =
  | { parsed: true; cursor: number }
  | { parsed: false; missingKey?: boolean; kver?: string }

const BATCH_PROGRESS_CACHE_MAX = 500
const OWN_PUSH_CACHE_MAX = 1000
const KEY_WAIT_TIMEOUT_MS = SYNC_TIMEOUTS.keyWait

export class SyncPullQueueManager implements LifecycleAware<{ clearLocalData?: boolean }> {
  readonly lifecycleName = 'PullQueueManager'
  private isShutdown = false
  private account: string | null = null

  async onLifecycleStop(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.shutdown(options)
  }

  private readonly retryTracker: PullRetryTracker
  private hasMoreGlobal = false
  private globalPageToken?: PageToken

  /** For each item, how many messages of each partly applied batch (by cursor) have been applied */
  private readonly batchProgress = new BoundedMap<ItemId, Map<number, number>>(BATCH_PROGRESS_CACHE_MAX)
  // "itemId:cursor" of messages this device pushed, so their server echoes aren't mistaken for remote edits
  private readonly ownPushedMessageKeys = new BoundedSet<string>(OWN_PUSH_CACHE_MAX)

  private readonly saveCursorsDebounced = debounce(() => fireAndForget(this.persistCursors(), 'SyncPullQueueManager:persistCursors'), 1000)

  constructor(
    private readonly cursorStore: CursorStore,
    private readonly keys: KeyProvider,
    private readonly lockCoordinator: ItemLockCoordinator,
    private readonly internalEventHub: WorkerInternalEventHub,
  ) {
    this.retryTracker = new PullRetryTracker(keys)
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

  setAccount(account: string | null): Promise<void> {
    this.saveCursorsDebounced.cancel()
    this.account = account
    this.isShutdown = false

    this.clearPullState()
    this.hasMoreGlobal = false
    this.globalPageToken = undefined
    this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying: false })

    if (account) {
      return this.loadCursors()
    }
    return Promise.resolve()
  }

  async loadCursors(): Promise<void> {
    if (this.isShutdown || !this.account) return
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
    if (!this.account) return
    const data = this.retryTracker.exportState()
    try {
      await this.cursorStore.saveCursors(data)
    } catch (error) {
      log.error('Failed to save cursors', error)
    }
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    if (this.isShutdown) return
    this.isShutdown = true

    this.saveCursorsDebounced.cancel()
    if (!options?.clearLocalData) {
      await this.persistCursors()
    }
    this.clearPullState()
    this.hasMoreGlobal = false
    this.account = null
  }

  addPendingItem(itemId: ItemId): void {
    this.retryTracker.addPendingItem(itemId)
  }

  private notifyMessageParsed(itemId: ItemId, documentId: DocumentId, message: Uint8Array): void {
    if (!this.internalEventHub.emit({ type: 'messageParsed', itemId, documentId, message })) {
      throw new Error(`Listener failed while processing messageParsed for item ${itemId}`)
    }
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
        onKeyVersionMissing: missingKver => {
          this.internalEventHub.emit({ type: 'keyVersionMissing', kver: missingKver })
        },
      })
    } catch (error) {
      const classified = classifySyncError(error)
      if (classified.isMissingKey) {
        return { parsed: false, missingKey: true, kver: classified.kver }
      }
      return { parsed: false }
    }

    const isBatched = entry.encryptedMessage.version === BATCHED_MESSAGE_VERSION
    try {
      if (isBatched) {
        const success = parseBatchedMessages(
          itemId,
          documentId,
          decrypted,
          (id, docId, msg) => this.notifyMessageParsed(id, docId, msg),
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
      } else {
        this.notifyMessageParsed(itemId, documentId, decrypted)
      }
    } catch (error) {
      if (!isBatched) {
        log.error('Error processing message', error)
      }
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
      this.internalEventHub.emit({ type: 'flushNeeded' })
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

  private async withItemLock<T>(itemId: ItemId, fn: () => Promise<T>): Promise<T> {
    return this.lockCoordinator.withItemLock(itemId, fn)
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
      return {
        highestCursor: initialCursor,
        hasParseFailure: false,
        hasKeyFailure: false,
        hasParsedMessages: false,
        hasParsedRemoteMessages: false,
      }
    }

    return this.withItemLock(itemId, async () => {
      let highestCursor = initialCursor
      let hasParseFailure = false
      let hasKeyFailure = false
      let blockedOnKey: string | undefined
      let failingCursor: number | undefined
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
          hasKeyFailure = true
          blockedOnKey = handled.kver
          break
        } else {
          hasParseFailure = true
          failingCursor = entry.cursor
          break
        }
      }

      return {
        highestCursor,
        hasParseFailure,
        hasKeyFailure,
        blockedOnKey,
        failingCursor,
        hasParsedMessages,
        hasParsedRemoteMessages,
      }
    })
  }

  private async processSinglePullResult(
    result: PullSyncMessagesResponse,
    timedOutKeys: Set<string>,
    advanceGlobalCursor: boolean,
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

    let highestCursor = messageResult.highestCursor
    if (
      !messageResult.hasParseFailure &&
      !messageResult.hasKeyFailure &&
      Number.isFinite(result.nextCursor)
    ) {
      highestCursor = Math.max(highestCursor, result.nextCursor)
    }

    const outcome = this.retryTracker.recordPullOutcome({
      itemId,
      initialCursor,
      highestCursor,
      isNewItem,
      hasKeyFailure: messageResult.hasKeyFailure,
      blockedOnKey: messageResult.blockedOnKey,
      hasParseFailure: messageResult.hasParseFailure,
      failingCursor: messageResult.failingCursor,
      hasMore,
      nextCursor: result.nextCursor,
      pageToken: result.nextPageToken,
      advanceGlobalCursor,
    })

    if (highestCursor > initialCursor) {
      this.clearBatchProgressUpTo(itemId, highestCursor)
    }

    if (
      outcome.permanentlyFailed ||
      (!messageResult.hasParseFailure && !messageResult.hasKeyFailure && !hasMore)
    ) {
      this.batchProgress.delete(itemId)
    }

    if (
      messageResult.hasParsedRemoteMessages &&
      !messageResult.hasParseFailure &&
      !messageResult.hasKeyFailure &&
      !outcome.permanentlyFailed
    ) {
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
   * @param globalScannedThroughCursor Global scan position reported by the server. When provided,
   * it alone advances the global cursor; per-item results (which may run ahead of the scan) do not.
   * Older servers omit it, in which case per-item results advance the global cursor as before.
   */
  async processPullResults(
    results: PullSyncMessagesResponse[],
    hasMoreGlobal?: boolean,
    globalNextPageToken?: PageToken,
    globalScannedThroughCursor?: number,
  ): Promise<void> {
    if (!this.account || this.isShutdown) return
    if (typeof hasMoreGlobal === 'boolean') {
      this.hasMoreGlobal = hasMoreGlobal
      this.globalPageToken = hasMoreGlobal ? globalNextPageToken : undefined
    }

    const successfullyPulledItemIds = new Set<ItemId>()
    let cursorsUpdated = false
    const timedOutKeys = new Set<string>()

    try {
      for (const result of results || []) {
        try {
          const itemOutcome = await this.processSinglePullResult(
            result,
            timedOutKeys,
            globalScannedThroughCursor === undefined,
          )
          if (itemOutcome.hasParsedMessages) {
            successfullyPulledItemIds.add(itemOutcome.itemId)
          }
          if (itemOutcome.cursorUpdated) {
            cursorsUpdated = true
          }
        } catch (innerError) {
          log.error(`Pull sync failed for item: ${result.itemId}`, innerError)
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
    } catch (error) {
      log.error('Pull sync batch failed', error)
      throw error
    } finally {
      const isRetrying = this.retryTracker.isAnyRetrying()
      this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying })
      if (this.account && successfullyPulledItemIds.size > 0) {
        try {
          publishRealtimeBusSyncPing(this.account, Array.from(successfullyPulledItemIds))
        } catch (error) {
          log.error('publishRealtimeBusSyncPing failed', error)
        }
      }
    }
  }

  exportCursors(): [ItemId, number][] {
    return this.retryTracker.exportCursors()
  }

  async importCursors(cursors: [ItemId, number][]): Promise<void> {
    if (!this.account) return
    this.retryTracker.importCursors(cursors)
    for (const [itemId, cursor] of cursors) {
      this.clearBatchProgressUpTo(itemId, cursor)
    }
    await this.cursorStore.saveCursors(this.retryTracker.exportState())
  }
}
