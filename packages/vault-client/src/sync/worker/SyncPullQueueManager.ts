import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from '../../api/SyncWorkerClient'
import type { KeyProvider } from '../../api/Keyring'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import { decryptWithKeyResolution } from './utils/decryptWithKeyResolution'
import { classifySyncError } from './utils/errorClassifier'
import { ItemId } from '@vault/shared'
import type { PageToken } from '@vault/shared'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'
import type { ItemLockCoordinator } from './docStore'
import { PullRetryTracker } from './PullRetryTracker'
import { WorkerInternalEventHub } from './SyncEventHub'
import { BoundedMap, BoundedSet } from '../utils/boundedCollections'
import { SYNC_TIMEOUTS } from '../syncConfig'
import type { LifecycleAware } from './ServiceLifecycleManager'
import { fireAndForget } from '../utils/fireAndForget'

interface ProcessItemMessagesResult {
  highestCursor: number
  hasParseFailure: boolean
  hasKeyFailure: boolean
  blockedOnKey?: string
  failingCursor?: number
  hasParsedMessages: boolean
  hasParsedRemoteMessages: boolean
}

const BATCH_PROGRESS_CACHE_MAX = 500
const OWN_PUSH_CACHE_MAX = 1000
const KEY_WAIT_TIMEOUT_MS = SYNC_TIMEOUTS.keyWait
const PROTOCOL_VERSION = '1.0'

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
  public static readonly MAX_PULL_RETRIES = PullRetryTracker.MAX_PULL_RETRIES

  private readonly batchProgress = new BoundedMap<string, number>(BATCH_PROGRESS_CACHE_MAX) // "itemId:cursor" -> succeeded prefix count
  // "itemId:cursor" of messages this device pushed, so their server echoes aren't mistaken for remote edits
  private readonly ownPushedMessageKeys = new BoundedSet<string>(OWN_PUSH_CACHE_MAX)

  private readonly saveCursorsDebounced = debounce(() => fireAndForget(this.persistCursors(), 'SyncPullQueueManager:persistCursors'), 1000)

  private lockCoordinator?: ItemLockCoordinator
  private internalEventHub: WorkerInternalEventHub

  constructor(
    private readonly cursorStore: CursorStore,
    private readonly keys: KeyProvider,
    lockCoordinator?: ItemLockCoordinator,
    internalEventHub?: WorkerInternalEventHub,
  ) {
    this.retryTracker = new PullRetryTracker(keys)
    this.lockCoordinator = lockCoordinator
    this.internalEventHub = internalEventHub ?? new WorkerInternalEventHub()
  }

  public get eventHub(): WorkerInternalEventHub {
    return this.internalEventHub
  }

  public setInternalEventHub(hub: WorkerInternalEventHub): void {
    this.internalEventHub = hub
  }

  public setLockCoordinator(coordinator?: ItemLockCoordinator): void {
    this.lockCoordinator = coordinator
  }

  private makeBatchProgressKey(itemId: ItemId, cursor: number): string {
    return `${itemId}:${cursor}`
  }

  recordOwnPushedMessage(itemId: ItemId, cursor: number): void {
    this.ownPushedMessageKeys.add(this.makeBatchProgressKey(itemId, cursor))
  }

  private getBatchProgress(itemId: ItemId, cursor: number): number {
    return this.batchProgress.get(this.makeBatchProgressKey(itemId, cursor)) ?? 0
  }

  private setBatchProgress(itemId: ItemId, cursor: number, count: number): void {
    this.batchProgress.set(this.makeBatchProgressKey(itemId, cursor), count)
  }

  private clearBatchProgress(itemId: ItemId, cursor: number): void {
    this.batchProgress.delete(this.makeBatchProgressKey(itemId, cursor))
  }

  private clearBatchProgressForItem(itemId: ItemId): void {
    const prefix = `${itemId}:`
    for (const key of this.batchProgress.keys()) {
      if (key.startsWith(prefix)) {
        this.batchProgress.delete(key)
      }
    }
  }

  private clearBatchProgressUpTo(itemId: ItemId, cursor: number): void {
    const prefix = `${itemId}:`
    for (const key of this.batchProgress.keys()) {
      if (key.startsWith(prefix)) {
        const entryCursor = Number(key.slice(prefix.length))
        if (!Number.isFinite(entryCursor) || entryCursor <= cursor) {
          this.batchProgress.delete(key)
        }
      }
    }
  }

  getBatchProgressCountForTesting(): number {
    return this.batchProgress.size
  }

  hasBatchProgressForTesting(itemId: ItemId, cursor: number): boolean {
    return this.batchProgress.has(this.makeBatchProgressKey(itemId, cursor))
  }

  setAccount(account: string | null): Promise<void> {
    this.saveCursorsDebounced.cancel()
    this.account = account
    this.isShutdown = false

    this.retryTracker.clear()
    this.batchProgress.clear()
    this.ownPushedMessageKeys.clear()
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
      console.error('[SyncPullQueueManager] Failed to load cursors', error)
    }
  }

  async reloadCursors(): Promise<void> {
    await this.loadCursors()
  }

  async persistCursors(): Promise<void> {
    if (!this.account) return
    const data = this.retryTracker.exportState()
    try {
      await this.cursorStore.saveCursors(data)
    } catch (error) {
      console.error('[SyncPullQueueManager] Failed to save cursors', error)
    }
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    if (this.isShutdown) return
    this.isShutdown = true

    this.saveCursorsDebounced.cancel()
    if (!options?.clearLocalData) {
      await this.persistCursors()
    }
    this.retryTracker.clear()
    this.batchProgress.clear()
    this.ownPushedMessageKeys.clear()
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
  ): Promise<{ parsed: boolean; cursor?: number; missingKey?: boolean; kver?: string }> {
    if (!entry?.encryptedMessage?.iv || !entry?.encryptedMessage?.cipher) {
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

    try {
      const isBatched = entry.encryptedMessage.version === PROTOCOL_VERSION
      let hasError = false
      if (isBatched) {
        const startIndex = Number.isFinite(entry.cursor)
          ? this.getBatchProgress(itemId, entry.cursor)
          : 0

        const success = parseBatchedMessages(
          itemId,
          documentId,
          decrypted,
          (id, docId, msg) => this.notifyMessageParsed(id, docId, msg),
          {
            startIndex,
            onMessageSuccess: index => {
              if (Number.isFinite(entry.cursor)) {
                this.setBatchProgress(itemId, entry.cursor, index + 1)
              }
            },
          }
        )
        if (!success) {
          hasError = true
        }
      } else {
        try {
          this.notifyMessageParsed(itemId, documentId, decrypted)
        } catch (error) {
          console.error('[SyncPullQueueManager] Error processing message', error)
          hasError = true
        }
      }

      if (hasError) {
        return { parsed: false }
      }

      return { parsed: true, cursor: entry.cursor }
    } catch {
      return { parsed: false }
    }
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
      this.internalEventHub.emit({ type: 'pendingPullsAvailable' })
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
    if (this.lockCoordinator) {
      return this.lockCoordinator.withItemLock(itemId, fn)
    }
    return fn()
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
    const sortedMessages = [...(messages || [])].sort((a, b) => {
      const cursorA = Number.isFinite(a?.cursor) ? (a.cursor as number) : 0
      const cursorB = Number.isFinite(b?.cursor) ? (b.cursor as number) : 0
      if (cursorA < cursorB) return -1
      if (cursorA > cursorB) return 1
      return 0
    })

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
        if (Number.isFinite(entry.cursor) && (entry.cursor as number) <= initialCursor) {
          this.clearBatchProgress(itemId, entry.cursor as number)
          highestCursor = Math.max(highestCursor, entry.cursor as number)
          continue
        }

        const handled = await this.handleMessageEntry(itemId, documentId, entry, timedOutKeys)
        if (handled.parsed) {
          hasParsedMessages = true
          if (Number.isFinite(handled.cursor)) {
            const ownKey = this.makeBatchProgressKey(itemId, handled.cursor!)
            if (!this.ownPushedMessageKeys.has(ownKey)) {
              hasParsedRemoteMessages = true
            }
            this.ownPushedMessageKeys.delete(ownKey)
            this.clearBatchProgress(itemId, handled.cursor!)
            highestCursor = Math.max(highestCursor, handled.cursor!)
          }
        } else if (handled.missingKey) {
          hasKeyFailure = true
          blockedOnKey = handled.kver
          break
        } else {
          hasParseFailure = true
          failingCursor = entry?.cursor
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
      typeof result.nextCursor === 'number' &&
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
      this.clearBatchProgressForItem(itemId)
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
          console.error(`[SyncPullQueueManager] Pull sync failed for item: ${result.itemId}`, innerError)
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
      console.error('[SyncPullQueueManager] Pull sync batch failed', error)
      throw error
    } finally {
      const isRetrying = this.retryTracker.isAnyRetrying()
      this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying })
      if (this.account && successfullyPulledItemIds.size > 0) {
        try {
          publishRealtimeBusSyncPing(this.account, Array.from(successfullyPulledItemIds))
        } catch (error) {
          console.error('[SyncPullQueueManager] publishRealtimeBusSyncPing failed', error)
        }
      }
    }
  }

  hasPendingPulls(): boolean {
    if (this.hasMoreGlobal) {
      return true
    }
    return this.retryTracker.hasPendingPulls()
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

  async resetCursors(): Promise<void> {
    if (!this.account) return
    this.retryTracker.clear()
    this.batchProgress.clear()
    this.ownPushedMessageKeys.clear()
    await this.cursorStore.clear()
    this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying: false })
  }
}
