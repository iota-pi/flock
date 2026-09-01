import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from '../../api/vault/SyncWorkerClient'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { decryptBytes } from 'src/api/vault'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'

export interface ItemPullState {
  cursor: number
  pending: boolean
  retryCount: number
}

export class SyncPullQueueManager {
  private account: string | null = null
  private readonly itemStates = new Map<ItemId, ItemPullState>()
  public static readonly MAX_PULL_RETRIES = 5

  private readonly seenMessageCursors = new Set<string>() // "itemId:cursor" compound keys
  private static readonly SEEN_CACHE_MAX = 2000

  private readonly saveCursorsDebounced = debounce(() => void this.persistCursors(), 1000)

  public onMessageParsed: (itemId: ItemId, documentId: DocumentId, message: Uint8Array) => void = () => {}
  public onDecryptionFailure: ((itemId: ItemId, error: unknown) => void) | null = null
  public onRetryingStateChange: ((isRetrying: boolean) => void) | null = null

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
      if (state.retryCount > 0) return true
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

  setAccount(account: string | null): Promise<void> {
    this.saveCursorsDebounced.cancel()
    this.account = account

    this.itemStates.clear()
    this.seenMessageCursors.clear()
    this.onRetryingStateChange?.(false)

    if (account) {
      return this.loadCursors()
    }
    return Promise.resolve()
  }

  private async loadCursors(): Promise<void> {
    try {
      const stored = await this.cursorStore.loadCursors()
      if (stored && Array.isArray(stored)) {
        for (const [itemId, cursor] of stored) {
          const state = this.getOrCreateState(itemId)
          state.cursor = cursor
        }
      }
    } catch (error) {
      console.error('[SyncPullQueueManager] Failed to load cursors', error)
    }
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

  async shutdown(): Promise<void> {
    this.saveCursorsDebounced.cancel()
    await this.persistCursors()
    this.itemStates.clear()
    this.seenMessageCursors.clear()
  }

  addPendingItem(itemId: ItemId): void {
    if (!itemId) return
    const state = this.getOrCreateState(itemId)
    state.pending = true
  }

  private async handleMessageEntry(
    itemId: ItemId,
    documentId: DocumentId,
    entry: PullSyncMessagesResponse['messages'][number],
  ): Promise<{ parsed: boolean; cursor?: number }> {
    if (!entry?.encryptedMessage?.iv || !entry?.encryptedMessage?.cipher) {
      return { parsed: false }
    }

    try {
      const decrypted = await decryptBytes(entry.encryptedMessage)
      const isBatched = entry.encryptedMessage.version === '1.0'
      let hasError = false
      if (isBatched) {
        const success = parseBatchedMessages(itemId, documentId, decrypted, this.onMessageParsed)
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
    } catch {
      return { parsed: false }
    }
  }

  getCursors(): Array<{ itemId: ItemId; cursor: number }> {
    const cursors: Array<{ itemId: ItemId; cursor: number }> = []

    for (const [itemId, state] of this.itemStates.entries()) {
      if (state.pending) {
        cursors.push({ itemId, cursor: state.cursor })
      }
    }

    return cursors
  }

  getGlobalLatestCursor(): number {
    let max = 0
    for (const state of this.itemStates.values()) {
      if (state.cursor > max) max = state.cursor
    }
    return max
  }

  async processPullResults(results: PullSyncMessagesResponse[]): Promise<void> {
    if (!this.account) return

    const successfullyPulledItemIds = new Set<ItemId>()
    let cursorsUpdated = false

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

          const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

          for (const entry of result.messages || []) {
            if (Number.isFinite(entry.cursor) && this.hasSeen(itemId, entry.cursor)) {
              continue // overlap window dedup
            }
            const handled = await this.handleMessageEntry(itemId, documentId, entry)
            if (handled.parsed) {
              successfullyPulledItemIds.add(itemId)
              if (Number.isFinite(handled.cursor)) {
                this.markSeen(itemId, handled.cursor!)
                highestCursor = Math.max(highestCursor, handled.cursor!)
              }
            } else {
              hasParseFailure = true
              break
            }
          }

          if (!hasParseFailure && Number.isFinite(result.nextCursor)) {
            highestCursor = Math.max(highestCursor, result.nextCursor)
          }

          if (highestCursor > originalCursor) {
            state.cursor = highestCursor
            cursorsUpdated = true
          } else if (!hasExisting && highestCursor >= 0) {
            state.cursor = highestCursor
            cursorsUpdated = true
          }

          if (hasMore && !hasParseFailure) {
            state.pending = true
            state.retryCount = 0 // success resets counter
          } else if (hasParseFailure) {
            state.retryCount += 1
            if (state.retryCount >= SyncPullQueueManager.MAX_PULL_RETRIES) {
              state.pending = false
              state.retryCount = 0
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

  processPushResults(results: Array<{ itemId: ItemId; cursor: number }>): void {
    if (!this.account) return
    let cursorsUpdated = false
    for (const res of results) {
      if (res.itemId && Number.isFinite(res.cursor)) {
        const state = this.getOrCreateState(res.itemId)
        if (res.cursor > state.cursor) {
          state.cursor = res.cursor
          cursorsUpdated = true
        }
        state.pending = false
      }
    }
    if (cursorsUpdated) {
      this.saveCursorsDebounced()
    }
  }

  hasPendingPulls(): boolean {
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
    await this.cursorStore.clear()
    this.onRetryingStateChange?.(false)
  }
}
