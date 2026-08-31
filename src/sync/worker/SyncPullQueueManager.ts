import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from '../../api/vault/SyncWorkerClient'
import { toAutomergeUrlFromItemId } from './utils/automerge'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { decryptBytes } from 'src/api/vault'
import { ItemId } from 'src/shared/schemas/items'
import { CursorStore } from './stores/CursorStore'
import { parseBatchedMessages } from './utils/messageParser'

export class SyncPullQueueManager {
  private account: string | null = null
  private readonly pendingPullItemIds = new Set<ItemId>()
  private readonly retryCountByItemId = new Map<ItemId, number>()
  private static readonly MAX_PULL_RETRIES = 5

  private readonly seenMessageCursors = new Set<string>() // "itemId:cursor" compound keys
  private static readonly SEEN_CACHE_MAX = 2000

  private cursorByItemId = new Map<ItemId, number>()
  private readonly saveCursorsDebounced = debounce(() => void this.persistCursors(), 1000)

  public onMessageParsed: (itemId: ItemId, documentId: DocumentId, message: Uint8Array) => void = () => {}
  public onDecryptionFailure: ((itemId: ItemId, error: unknown) => void) | null = null

  constructor(private readonly cursorStore: CursorStore) {}

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

    this.pendingPullItemIds.clear()
    this.retryCountByItemId.clear()
    this.seenMessageCursors.clear()
    this.cursorByItemId.clear()

    if (account) {
      return this.loadCursors()
    }
    return Promise.resolve()
  }

  private async loadCursors(): Promise<void> {
    try {
      const stored = await this.cursorStore.loadCursors()
      if (stored && Array.isArray(stored)) {
        this.cursorByItemId = new Map(stored)
      }
    } catch (error) {
      console.error('[SyncPullQueueManager] Failed to load cursors', error)
    }
  }


  async persistCursors(): Promise<void> {
    if (!this.account) return
    const data = Array.from(this.cursorByItemId.entries())
    try {
      await this.cursorStore.saveCursors(data)
    } catch (error) {
      console.error('[SyncPullQueueManager] Failed to save cursors', error)
    }
  }

  async shutdown(): Promise<void> {
    this.saveCursorsDebounced.cancel()
    await this.persistCursors()
    this.pendingPullItemIds.clear()
    this.retryCountByItemId.clear()
    this.seenMessageCursors.clear()
    this.cursorByItemId.clear()
  }

  addPendingItem(itemId: ItemId): void {
    if (!itemId) return
    this.pendingPullItemIds.add(itemId)
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

    const targetItemIds = new Set([...this.pendingPullItemIds])
    for (const itemId of targetItemIds) {
      const cursor = this.cursorByItemId.get(itemId) ?? 0
      cursors.push({ itemId, cursor })
    }

    return cursors
  }

  getGlobalLatestCursor(): number {
    let max = 0
    for (const cursor of this.cursorByItemId.values()) {
      if (cursor > max) max = cursor
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
          const hasExisting = this.cursorByItemId.has(itemId)
          const originalCursor = this.cursorByItemId.get(itemId) || 0
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
            this.cursorByItemId.set(itemId, highestCursor)
            cursorsUpdated = true
          } else if (!hasExisting && highestCursor >= 0) {
            this.cursorByItemId.set(itemId, highestCursor)
            cursorsUpdated = true
          }

          if (hasMore && !hasParseFailure) {
            this.pendingPullItemIds.add(itemId)
            this.retryCountByItemId.delete(itemId) // success resets counter
          } else if (hasParseFailure) {
            const retries = (this.retryCountByItemId.get(itemId) ?? 0) + 1
            this.retryCountByItemId.set(itemId, retries)
            if (retries >= SyncPullQueueManager.MAX_PULL_RETRIES) {
              this.pendingPullItemIds.delete(itemId)
              this.retryCountByItemId.delete(itemId)
              this.onDecryptionFailure?.(
                itemId,
                new Error(
                  `Permanently failed to parse sync messages after ${retries} attempts`
                )
              )
            } else {
              this.pendingPullItemIds.add(itemId)
            }
          } else {
            this.pendingPullItemIds.delete(itemId)
            this.retryCountByItemId.delete(itemId)
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
        const current = this.cursorByItemId.get(res.itemId) || 0
        if (res.cursor > current) {
          this.cursorByItemId.set(res.itemId, res.cursor)
          cursorsUpdated = true
        }
        this.pendingPullItemIds.delete(res.itemId)
      }
    }
    if (cursorsUpdated) {
      this.saveCursorsDebounced()
    }
  }

  hasPendingPulls(): boolean {
    return this.pendingPullItemIds.size > 0
  }

  exportCursors(): [ItemId, number][] {
    return Array.from(this.cursorByItemId.entries())
  }


  async importCursors(cursors: [ItemId, number][]): Promise<void> {
    if (!this.account) return
    this.cursorByItemId = new Map(cursors)
    await this.cursorStore.saveCursors(cursors)
  }

  async resetCursors(): Promise<void> {
    if (!this.account) return
    this.cursorByItemId.clear()
    this.pendingPullItemIds.clear()
    await this.cursorStore.clear()
  }
}
