import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from '../../api/vault/SyncWorkerClient'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { decryptWithKeyResolution, MissingKeyError } from './utils/decryptWithKeyResolution'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'
import type { ItemLockCoordinator } from './docStore'
import { PullRetryTracker } from './PullRetryTracker'
import { WorkerInternalEventHub } from './SyncEventHub'
import { BoundedMap } from '../utils/boundedCollections'

interface ProcessItemMessagesResult {
  highestCursor: number
  hasParseFailure: boolean
  hasKeyFailure: boolean
  blockedOnKey?: string
  failingCursor?: number
  hasParsedMessages: boolean
}

export class SyncPullQueueManager {
  private isShutdown = false
  private account: string | null = null
  private readonly retryTracker = new PullRetryTracker()
  private hasMoreGlobal = false
  private globalLastEvaluatedKey?: Record<string, unknown>
  public static readonly MAX_PULL_RETRIES = PullRetryTracker.MAX_PULL_RETRIES

  private static readonly BATCH_PROGRESS_CACHE_MAX = 500
  private readonly batchProgress = new BoundedMap<string, number>(SyncPullQueueManager.BATCH_PROGRESS_CACHE_MAX) // "itemId:cursor" -> succeeded prefix count

  private readonly saveCursorsDebounced = debounce(() => void this.persistCursors(), 1000)

  private lockCoordinator?: ItemLockCoordinator
  private internalEventHub: WorkerInternalEventHub
  public keyWaitTimeoutMs = 5000

  constructor(
    private readonly cursorStore: CursorStore,
    lockCoordinator?: ItemLockCoordinator,
    internalEventHub?: WorkerInternalEventHub,
  ) {
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

  setAccount(account: string | null): Promise<void> {
    this.saveCursorsDebounced.cancel()
    this.account = account
    this.isShutdown = false

    this.retryTracker.clear()
    this.batchProgress.clear()
    this.hasMoreGlobal = false
    this.globalLastEvaluatedKey = undefined
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
    this.hasMoreGlobal = false
    this.account = null
  }

  addPendingItem(itemId: ItemId): void {
    this.retryTracker.addPendingItem(itemId)
  }

  private notifyMessageParsed(itemId: ItemId, documentId: DocumentId, message: Uint8Array): void {
    this.internalEventHub.emit({ type: 'messageParsed', itemId, documentId, message })
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
      decrypted = await decryptWithKeyResolution(entry.encryptedMessage, {
        timeoutMs: this.keyWaitTimeoutMs,
        timedOutKeys,
        onKeyVersionMissing: missingKver => {
          this.internalEventHub.emit({ type: 'keyVersionMissing', kver: missingKver })
        },
      })
    } catch (error) {
      if (error instanceof MissingKeyError) {
        return { parsed: false, missingKey: true, kver: error.kver }
      }
      return { parsed: false }
    }

    try {
      const isBatched = entry.encryptedMessage.version === '1.0'
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

  getCursors(): Array<{ itemId: ItemId; cursor: number; lastEvaluatedKey?: Record<string, unknown> }> {
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

  getGlobalLastEvaluatedKey(): Record<string, unknown> | undefined {
    return this.hasMoreGlobal ? this.globalLastEvaluatedKey : undefined
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
      }
    }

    return this.withItemLock(itemId, async () => {
      let highestCursor = initialCursor
      let hasParseFailure = false
      let hasKeyFailure = false
      let blockedOnKey: string | undefined
      let failingCursor: number | undefined
      let hasParsedMessages = false

      for (const entry of sortedMessages) {
        if (Number.isFinite(entry.cursor) && (entry.cursor as number) <= initialCursor) {
          highestCursor = Math.max(highestCursor, entry.cursor as number)
          continue
        }

        const handled = await this.handleMessageEntry(itemId, documentId, entry, timedOutKeys)
        if (handled.parsed) {
          hasParsedMessages = true
          if (Number.isFinite(handled.cursor)) {
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
      }
    })
  }

  private async processSinglePullResult(
    result: PullSyncMessagesResponse,
    timedOutKeys: Set<string>
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
      lastEvaluatedKey: result.lastEvaluatedKey,
    })

    if (outcome.permanentlyFailed) {
      this.clearBatchProgressForItem(itemId)

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

  async processPullResults(
    results: PullSyncMessagesResponse[],
    hasMoreGlobal?: boolean,
    globalLastEvaluatedKey?: Record<string, unknown>
  ): Promise<void> {
    if (!this.account || this.isShutdown) return
    if (typeof hasMoreGlobal === 'boolean') {
      this.hasMoreGlobal = hasMoreGlobal
      this.globalLastEvaluatedKey = hasMoreGlobal ? globalLastEvaluatedKey : undefined
    }

    const successfullyPulledItemIds = new Set<ItemId>()
    let cursorsUpdated = false
    const timedOutKeys = new Set<string>()

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
          console.error(`[SyncPullQueueManager] Pull sync failed for item: ${result.itemId}`, innerError)
        }
      }

      if (cursorsUpdated) {
        this.saveCursorsDebounced()
      }
    } catch (error) {
      console.error('[SyncPullQueueManager] Pull sync batch failed', error)
    } finally {
      const isRetrying = this.retryTracker.isAnyRetrying()
      this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying })
      if (successfullyPulledItemIds.size > 0) {
        try {
          publishRealtimeBusSyncPing(Array.from(successfullyPulledItemIds))
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
    await this.cursorStore.saveCursors(this.retryTracker.exportState())
  }

  async resetCursors(): Promise<void> {
    if (!this.account) return
    this.retryTracker.clear()
    this.batchProgress.clear()
    await this.cursorStore.clear()
    this.internalEventHub.emit({ type: 'retryingStateChange', isRetrying: false })
  }
}
