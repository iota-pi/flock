import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import localforage from 'localforage'
import { debounce } from 'lodash-es'

import type { PullSyncMessagesResponse } from '../../api/vault/SyncWorkerClient'
import { reportDecryptionFailure } from '../../api/syncHealthCoordinator'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { publishRealtimeBusSyncPing } from '../client/realtimeBus'
import { decryptBytes } from 'src/api/vault'
import { runStorageOperation } from '../../utils/storageManager'
import { ItemId } from 'src/shared/schemas/items'


export class SyncPullQueueManager {
  private account: string | null = null
  private readonly pendingPullItemIds = new Set<ItemId>()
  private cursorByItemId = new Map<ItemId, number>()
  private cursorStore: LocalForage | null = null
  private readonly saveCursorsDebounced = debounce(() => void this.persistCursors(), 1000)

  public onMessageParsed: (itemId: ItemId, documentId: DocumentId, message: Uint8Array) => void = () => {}

  async setAccount(account: string | null): Promise<void> {
    this.saveCursorsDebounced.cancel()
    this.account = account
    this.pendingPullItemIds.clear()
    this.cursorByItemId.clear()

    if (account) {
      this.cursorStore = localforage.createInstance({
        name: 'flock-sync-cursors',
        storeName: `cursors-${account}`,
      })
      await this.loadCursors()
    } else {
      this.cursorStore = null
    }
  }

  private async loadCursors(): Promise<void> {
    if (!this.cursorStore) return
    try {
      const stored = await this.cursorStore.getItem<[ItemId, number][]>('cursorByItemId')
      if (stored && Array.isArray(stored)) {
        this.cursorByItemId = new Map(stored)
      }
    } catch (error) {
      console.error('[SyncPullQueueManager] Failed to load cursors', error)
    }
  }

  async persistCursors(): Promise<void> {
    if (!this.cursorStore) return
    const data = Array.from(this.cursorByItemId.entries())
    try {
      await runStorageOperation(() => this.cursorStore!.setItem('cursorByItemId', data))
    } catch (error) {
      console.error('[SyncPullQueueManager] Failed to save cursors', error)
    }
  }

  async shutdown(): Promise<void> {
    this.saveCursorsDebounced.cancel()
    await this.persistCursors()
    this.saveCursorsDebounced.cancel()
    this.pendingPullItemIds.clear()
    this.cursorByItemId.clear()
    this.cursorStore?.clear().catch(error => {
      console.error('[SyncPullQueueManager] Failed to clear cursor store', error)
    })
  }

  addPendingItem(itemId: ItemId): void {
    if (!itemId) return
    this.pendingPullItemIds.add(itemId)
  }

  private parseBatchedMessages(itemId: ItemId, documentId: DocumentId, decrypted: Uint8Array): void {
    let offset = 0
    const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength)
    while (offset < decrypted.byteLength) {
      try {
        const length = view.getUint32(offset, false)
        offset += 4
        const msg = new Uint8Array(decrypted.buffer, decrypted.byteOffset + offset, length)
        offset += length

        try {
          this.onMessageParsed(itemId, documentId, msg)
        } catch (error) {
          console.error('[SyncPullQueueManager] Error processing message in batch', error)
        }
      } catch (error) {
        console.error('[SyncPullQueueManager] Error parsing message batch structure', error)
        break
      }
    }
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

      if (isBatched) {
        this.parseBatchedMessages(itemId, documentId, decrypted)
      } else {
        try {
          this.onMessageParsed(itemId, documentId, decrypted)
        } catch (error) {
          console.error('[SyncPullQueueManager] Error processing message', error)
        }
      }

      return { parsed: true, cursor: entry.cursor }
    } catch (error) {
      if (this.account) {
        reportDecryptionFailure(this.account, {
          itemId,
          error
        })
      }
      return { parsed: false, cursor: entry.cursor }
    }
  }

  getAllCursors(): Array<{ itemId: ItemId; cursor: number }> {
    const cursors: Array<{ itemId: ItemId; cursor: number }> = []

    // Only include cursors for pending item IDs
    for (const itemId of this.pendingPullItemIds) {
      const cursor = this.cursorByItemId.get(itemId) ?? 0
      cursors.push({ itemId, cursor })
    }

    return cursors
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
          let highestCursor = this.cursorByItemId.get(itemId) || 0

          const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

          for (const entry of result.messages || []) {
            const handled = await this.handleMessageEntry(itemId, documentId, entry)
            if (handled.parsed) {
              successfullyPulledItemIds.add(itemId)
            }

            if (Number.isFinite(handled.cursor)) {
              highestCursor = Math.max(highestCursor, handled.cursor!)
            }
          }

          if (Number.isFinite(result.nextCursor)) {
            highestCursor = Math.max(highestCursor, result.nextCursor)
          }

          if (highestCursor >= 0) {
            this.cursorByItemId.set(itemId, highestCursor)
            cursorsUpdated = true
          }

          if (hasMore) {
            this.pendingPullItemIds.add(itemId)
          } else {
            this.pendingPullItemIds.delete(itemId)
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
    if (!this.cursorStore) return
    this.cursorByItemId = new Map(cursors)
    await this.cursorStore.setItem('cursorByItemId', cursors)
  }
}
