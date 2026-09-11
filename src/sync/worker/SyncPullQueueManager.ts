import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse, PushResultItem } from '../../api/vault/SyncWorkerClient'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { decryptBytes, hasVaultKey, waitForKeyVersion } from 'src/api/vault'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'

export interface ItemPullState {
  cursor: number
  pending: boolean
  retryCount: number
  blockedOnKey?: string
}

export class SyncPullQueueManager {
  private isShutdown = false
  private account: string | null = null
  private readonly itemStates = new Map<ItemId, ItemPullState>()
  private hasMoreGlobal = false
  public static readonly MAX_PULL_RETRIES = 5

  private readonly seenMessageCursors = new Set<string>() // "itemId:cursor" compound keys
  private static readonly SEEN_CACHE_MAX = 2000

  private readonly batchProgress = new Map<string, number>() // "itemId:cursor" -> succeeded prefix count
  private static readonly BATCH_PROGRESS_CACHE_MAX = 500

  private readonly saveCursorsDebounced = debounce(() => void this.persistCursors(), 1000)

  public onMessageParsed: (itemId: ItemId, documentId: DocumentId, message: Uint8Array) => void = () => {}
  public onDecryptionFailure: ((itemId: ItemId, error: unknown) => void) | null = null
  public onRetryingStateChange: ((isRetrying: boolean) => void) | null = null
  public onKeyVersionMissing: ((kver: string) => void) | null = null
  public onPendingPullsAvailable: (() => void) | null = null
  public keyWaitTimeoutMs = 5000

  constructor(private readonly cursorStore: CursorStore) {}

  private getOrCreateState(itemId: ItemId): ItemPullState {
    let state = this.itemStates.get(itemId)
    if (!state) {
      state = {
        cursor: 0,
        pending: false,
        retryCount: 0,
      }
      this.itemStates.set(itemId, state)
    }
    return state
  }

  private isAnyRetrying(): boolean {
    for (const state of this.itemStates.values()) {
      if (state.retryCount > 0 || (state.blockedOnKey && !hasVaultKey(state.blockedOnKey))) return true
    }
    return false
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

    this.itemStates.clear()
    this.seenMessageCursors.clear()
    this.batchProgress.clear()
    this.hasMoreGlobal = false
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
        for (const [itemId, cursor] of stored) {
          if (Number.isFinite(cursor) && cursor >= 0) {
            const state = this.getOrCreateState(itemId)
            state.cursor = Math.max(state.cursor, cursor)
          }
        }
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
    const data: [ItemId, number][] = []
    for (const [itemId, state] of this.itemStates.entries()) {
      if (state.cursor >= 0) {
        data.push([itemId, state.cursor])
      }
    }
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
    this.itemStates.clear()
    this.seenMessageCursors.clear()
    this.batchProgress.clear()
    this.hasMoreGlobal = false
    this.account = null
  }

  addPendingItem(itemId: ItemId): void {
    if (!itemId) return
    const state = this.getOrCreateState(itemId)
    state.pending = true
    if (state.blockedOnKey && hasVaultKey(state.blockedOnKey)) {
      state.blockedOnKey = undefined
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

  getCursors(): Array<{ itemId: ItemId; cursor: number }> {
    const cursors: Array<{ itemId: ItemId; cursor: number }> = []

    for (const [itemId, state] of this.itemStates.entries()) {
      if (state.blockedOnKey && !hasVaultKey(state.blockedOnKey)) {
        continue
      }
      if (state.pending) {
        cursors.push({ itemId, cursor: state.cursor })
      }
    }

    return cursors
  }

  hasImmediatePendingPulls(): boolean {
    if (this.hasMoreGlobal) {
      return true
    }
    for (const state of this.itemStates.values()) {
      if (state.pending && state.retryCount === 0 && (!state.blockedOnKey || hasVaultKey(state.blockedOnKey))) {
        return true
      }
    }
    return false
  }

  onKeyringUpdated(): void {
    let unblockedAny = false
    for (const state of this.itemStates.values()) {
      if (state.blockedOnKey && hasVaultKey(state.blockedOnKey)) {
        state.blockedOnKey = undefined
        state.pending = true
        state.retryCount = 0
        unblockedAny = true
      }
    }
    if (unblockedAny) {
      this.onRetryingStateChange?.(this.isAnyRetrying())
      this.onPendingPullsAvailable?.()
    }
  }

  getGlobalLatestCursor(): number {
    let max = 0
    for (const state of this.itemStates.values()) {
      if (state.cursor > max) max = state.cursor
    }
    return max
  }

  async processPullResults(results: PullSyncMessagesResponse[], hasMoreGlobal?: boolean): Promise<void> {
    if (!this.account || this.isShutdown) return
    if (typeof hasMoreGlobal === 'boolean') {
      this.hasMoreGlobal = hasMoreGlobal
    }

    const successfullyPulledItemIds = new Set<ItemId>()
    let cursorsUpdated = false
    const timedOutKeys = new Set<string>()

    try {
      for (const result of results || []) {
        try {
          const itemId = result.itemId
          const hasMore = result.hasMore === true
          const hasExisting = this.itemStates.has(itemId)
          const state = this.getOrCreateState(itemId)
          const originalCursor = state.cursor
          let highestCursor = originalCursor
          let hasParseFailure = false
          let hasKeyFailure = false
          let failingCursor: number | undefined
          const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

          // Sort messages ascending by cursor to ensure causal processing order and prevent
          // out-of-order cursors from prematurely advancing state.cursor if an earlier cursor fails.
          const sortedMessages = [...(result.messages || [])].sort((a, b) => {
            const cursorA = Number.isFinite(a?.cursor) ? (a.cursor as number) : 0
            const cursorB = Number.isFinite(b?.cursor) ? (b.cursor as number) : 0
            if (cursorA < cursorB) return -1
            if (cursorA > cursorB) return 1
            return 0
          })

          for (const entry of sortedMessages) {
            if (Number.isFinite(entry.cursor) && this.hasSeen(itemId, entry.cursor)) {
              highestCursor = Math.max(highestCursor, entry.cursor!)
              continue // overlap window dedup
            }
            const handled = await this.handleMessageEntry(itemId, documentId, entry, timedOutKeys)
            if (handled.parsed) {
              successfullyPulledItemIds.add(itemId)
              if (Number.isFinite(handled.cursor)) {
                this.markSeen(itemId, handled.cursor!)
                this.clearBatchProgress(itemId, handled.cursor!)
                highestCursor = Math.max(highestCursor, handled.cursor!)
              }
            } else if (handled.missingKey) {
              hasKeyFailure = true
              state.blockedOnKey = handled.kver
              break
            } else {
              hasParseFailure = true
              failingCursor = entry?.cursor
              break
            }
          }

          if (!hasParseFailure && !hasKeyFailure && typeof result.nextCursor === 'number' && Number.isFinite(result.nextCursor)) {
            highestCursor = Math.max(highestCursor, result.nextCursor)
          }

          if (hasKeyFailure) {
            state.pending = true
          } else if (hasMore && !hasParseFailure) {
            state.pending = true
            state.retryCount = 0 // success resets counter
            state.blockedOnKey = undefined
          } else if (hasParseFailure) {
            state.retryCount += 1
            if (state.retryCount >= SyncPullQueueManager.MAX_PULL_RETRIES) {
              state.pending = false
              state.retryCount = 0
              this.clearBatchProgressForItem(itemId)

              // Advance cursor past the permanently failing message so it is not re-fetched,
              // and mark it seen to dedup across overlap queries.
              const advanceCursor = Number.isFinite(failingCursor)
                ? (failingCursor as number)
                : (typeof result.nextCursor === 'number' && Number.isFinite(result.nextCursor) ? result.nextCursor : undefined)

              if (typeof advanceCursor === 'number') {
                this.markSeen(itemId, advanceCursor)
                highestCursor = Math.max(highestCursor, advanceCursor)
              }

              this.onDecryptionFailure?.(
                itemId,
                new Error(
                  `Permanently failed to parse sync messages after ${SyncPullQueueManager.MAX_PULL_RETRIES} attempts`
                )
              )
            } else {
              state.pending = true
            }
          } else {
            state.pending = false
            state.retryCount = 0
            state.blockedOnKey = undefined
          }

          if (highestCursor > originalCursor) {
            state.cursor = highestCursor
            cursorsUpdated = true
          } else if (!hasExisting && highestCursor >= 0) {
            state.cursor = highestCursor
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
      this.onRetryingStateChange?.(this.isAnyRetrying())
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
    for (const state of this.itemStates.values()) {
      if (state.pending) return true
    }
    return false
  }

  exportCursors(): [ItemId, number][] {
    const cursors: [ItemId, number][] = []
    for (const [itemId, state] of this.itemStates.entries()) {
      cursors.push([itemId, state.cursor])
    }
    return cursors
  }

  async importCursors(cursors: [ItemId, number][]): Promise<void> {
    if (!this.account) return
    this.itemStates.clear()
    for (const [itemId, cursor] of cursors) {
      const state = this.getOrCreateState(itemId)
      state.cursor = cursor
    }
    await this.cursorStore.saveCursors(cursors)
  }

  async resetCursors(): Promise<void> {
    if (!this.account) return
    this.itemStates.clear()
    this.batchProgress.clear()
    await this.cursorStore.clear()
    this.onRetryingStateChange?.(false)
  }
}
