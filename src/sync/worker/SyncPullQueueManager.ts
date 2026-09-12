import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse, PushResultItem } from '../../api/vault/SyncWorkerClient'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { decryptBytes, hasVaultKey, waitForKeyVersion } from 'src/api/vault'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'
import type { ItemLockCoordinator } from './docStore'
import { PullRetryTracker, type ItemPullState } from './PullRetryTracker'

export { type ItemPullState } from './PullRetryTracker'

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

  private readonly seenMessageCursors = new Set<string>() // "itemId:cursor" compound keys
  private static readonly SEEN_CACHE_MAX = 2000

  private readonly batchProgress = new Map<string, number>() // "itemId:cursor" -> succeeded prefix count
  private static readonly BATCH_PROGRESS_CACHE_MAX = 500

  private readonly saveCursorsDebounced = debounce(() => void this.persistCursors(), 1000)

  private lockCoordinator?: ItemLockCoordinator

  public onMessageParsed: (itemId: ItemId, documentId: DocumentId, message: Uint8Array) => void = () => {}
  public onDecryptionFailure: ((itemId: ItemId, error: unknown) => void) | null = null
  public onRetryingStateChange: ((isRetrying: boolean) => void) | null = null
  public onKeyVersionMissing: ((kver: string) => void) | null = null
  public onPendingPullsAvailable: (() => void) | null = null
  public keyWaitTimeoutMs = 5000

  constructor(
    private readonly cursorStore: CursorStore,
    lockCoordinator?: ItemLockCoordinator,
  ) {
    this.lockCoordinator = lockCoordinator
  }

  public setLockCoordinator(coordinator?: ItemLockCoordinator): void {
    this.lockCoordinator = coordinator
  }

  private makeSeenKey(itemId: ItemId, cursor: number): string {
    return `${itemId}:${cursor}`
  }

  private markSeen(itemId: ItemId, cursor: number): void {
    const key = this.makeSeenKey(itemId, cursor)
    this.seenMessageCursors.add(key)
    // Evict oldest entries if cache grows too large
    if (this.seenMessageCursors.size > SyncPullQueueManager.SEEN_CACHE_MAX) {
      const iterator = this.seenMessageCursors.values()
      const oldest = iterator.next().value
      if (oldest) this.seenMessageCursors.delete(oldest)
    }
  }

  private hasSeen(itemId: ItemId, cursor: number): boolean {
    return this.seenMessageCursors.has(this.makeSeenKey(itemId, cursor))
  }

  private getBatchProgress(itemId: ItemId, cursor: number): number {
    return this.batchProgress.get(this.makeSeenKey(itemId, cursor)) ?? 0
  }

  private setBatchProgress(itemId: ItemId, cursor: number, count: number): void {
    const key = this.makeSeenKey(itemId, cursor)
    this.batchProgress.set(key, count)
    if (this.batchProgress.size > SyncPullQueueManager.BATCH_PROGRESS_CACHE_MAX) {
      const oldest = this.batchProgress.keys().next().value
      if (oldest) this.batchProgress.delete(oldest)
    }
  }

  private clearBatchProgress(itemId: ItemId, cursor: number): void {
    this.batchProgress.delete(this.makeSeenKey(itemId, cursor))
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
    this.seenMessageCursors.clear()
    this.batchProgress.clear()
    this.hasMoreGlobal = false
    this.globalLastEvaluatedKey = undefined
    this.onRetryingStateChange?.(false)

    if (account) {
      return this.loadCursors()
    }
    return Promise.resolve()
  }

  async loadCursors(): Promise<void> {
    if (this.isShutdown || !this.account) return
    try {
      const stored = await this.cursorStore.loadCursors()
      if (stored && Array.isArray(stored)) {
        this.retryTracker.loadStoredCursors(stored)
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
    const data = this.retryTracker.exportValidCursors()
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
    this.seenMessageCursors.clear()
    this.batchProgress.clear()
    this.hasMoreGlobal = false
    this.account = null
  }

  addPendingItem(itemId: ItemId): void {
    this.retryTracker.addPendingItem(itemId)
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

    const kver = entry.encryptedMessage.kver || '1'
    if (!hasVaultKey(kver)) {
      if (timedOutKeys?.has(kver)) {
        return { parsed: false, missingKey: true, kver }
      }
      this.onKeyVersionMissing?.(kver)
      const keyAcquired = await waitForKeyVersion(kver, this.keyWaitTimeoutMs)
      if (!keyAcquired && !hasVaultKey(kver)) {
        timedOutKeys?.add(kver)
        return { parsed: false, missingKey: true, kver }
      }
    }

    try {
      const decrypted = await decryptBytes(entry.encryptedMessage)
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
          this.onMessageParsed,
          {
            startIndex,
            onMessageSuccess: (index) => {
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
          this.onMessageParsed(itemId, documentId, decrypted)
        } catch (error) {
          console.error('[SyncPullQueueManager] Error processing message', error)
          hasError = true
        }
      }

      if (hasError) {
        return { parsed: false }
      }

      return { parsed: true, cursor: entry.cursor }
    } catch (error: any) {
      if (!hasVaultKey(kver) || (typeof error?.message === 'string' && error.message.includes('not found in keyring'))) {
        return { parsed: false, missingKey: true, kver }
      }
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
      this.onRetryingStateChange?.(this.retryTracker.isAnyRetrying())
      this.onPendingPullsAvailable?.()
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
        if (Number.isFinite(entry.cursor) && this.hasSeen(itemId, entry.cursor)) {
          highestCursor = Math.max(highestCursor, entry.cursor!)
          continue // overlap window dedup
        }

        const handled = await this.handleMessageEntry(itemId, documentId, entry, timedOutKeys)
        if (handled.parsed) {
          hasParsedMessages = true
          if (Number.isFinite(handled.cursor)) {
            this.markSeen(itemId, handled.cursor!)
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

          if (messageResult.hasParsedMessages) {
            successfullyPulledItemIds.add(itemId)
          }

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

          if (outcome.cursorUpdated) {
            cursorsUpdated = true
          }

          if (outcome.permanentlyFailed) {
            this.clearBatchProgressForItem(itemId)

            // Advance cursor past the permanently failing message so it is not re-fetched,
            // and mark it seen to dedup across overlap queries.
            if (typeof outcome.advanceCursor === 'number') {
              this.markSeen(itemId, outcome.advanceCursor)
            }

            this.onDecryptionFailure?.(
              itemId,
              new Error(
                `Permanently failed to parse sync messages after ${PullRetryTracker.MAX_PULL_RETRIES} attempts`
              )
            )
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
      this.onRetryingStateChange?.(this.retryTracker.isAnyRetrying())
      if (successfullyPulledItemIds.size > 0) {
        try {
          publishRealtimeBusSyncPing(Array.from(successfullyPulledItemIds))
        } catch (error) {
          console.error('[SyncPullQueueManager] publishRealtimeBusSyncPing failed', error)
        }
      }
    }
  }

  processPushResults(results: Array<PushResultItem>): void {
    if (this.isShutdown || !this.account || !Array.isArray(results)) return
    for (const res of results) {
      if (res.itemId && typeof res.cursor === 'number' && Number.isFinite(res.cursor) && res.success !== false) {
        // Mark as seen so that if/when the client later pulls this message (e.g. during overlap window),
        // it is deduplicated without re-decrypting or re-parsing.
        // NOTE: We do NOT advance state.cursor or clear state.pending here:
        // 1. state.cursor tracks the PULL cursor. Advancing it from a push result would jump past
        //    peer messages at earlier cursors that haven't been pulled yet.
        // 2. state.pending tracks in-progress pulls (including multi-page pagination). Resetting it
        //    here would kill active pagination.
        this.markSeen(res.itemId, res.cursor)
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
    await this.cursorStore.saveCursors(cursors)
  }

  async resetCursors(): Promise<void> {
    if (!this.account) return
    this.retryTracker.clear()
    this.batchProgress.clear()
    await this.cursorStore.clear()
    this.onRetryingStateChange?.(false)
  }
}
