import type { PullSyncMessagesResponse } from '../api/vault/SyncWorkerClient'
import { reportDecryptionFailure } from '../api/syncHealthCoordinator'
import { toAutomergeUrlFromItemId } from './automergeRepoIds'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'
import { ACCOUNT_INDEX_DOCUMENT_ID } from './automergeConstants'
import localforage from 'localforage'
import { debounce } from 'lodash-es'
import { getVaultKey } from 'src/api/vault'
import { decryptBytesWithKey } from 'src/api/vault/crypto'

export class SyncPullQueueManager {
  private account: string | null = null
  private readonly pendingPullItemIds = new Set<string>()
  private cursorByItemId = new Map<string, number>()
  private cursorStore: LocalForage | null = null
  private readonly saveCursorsDebounced = debounce(() => this.saveCursors(), 1000)

  public onMessageParsed: (itemId: string, documentId: DocumentId, message: Uint8Array) => void = () => {}

  async setAccount(account: string | null): Promise<void> {
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
      const stored = await this.cursorStore.getItem<[string, number][]>('cursorByItemId')
      if (stored && Array.isArray(stored)) {
        this.cursorByItemId = new Map(stored)
      }
    } catch (error) {
      console.error('[SyncPullQueueManager] Failed to load cursors', error)
    }
  }

  private saveCursors(): void {
    if (!this.cursorStore) return
    const data = Array.from(this.cursorByItemId.entries())
    this.cursorStore.setItem('cursorByItemId', data).catch(error => {
      console.error('[SyncPullQueueManager] Failed to save cursors', error)
    })
  }

  clear(): void {
    this.pendingPullItemIds.clear()
    this.cursorByItemId.clear()
  }

  addPendingItem(itemId: string): void {
    if (!itemId) return
    this.pendingPullItemIds.add(itemId)
  }

  private parseBatchedMessages(itemId: string, documentId: DocumentId, decrypted: Uint8Array): void {
    let offset = 0
    const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength)
    while (offset < decrypted.byteLength) {
      const length = view.getUint32(offset, false)
      offset += 4
      const msg = new Uint8Array(decrypted.buffer, decrypted.byteOffset + offset, length)
      offset += length

      this.onMessageParsed(itemId, documentId, msg)
    }
  }

  private async handleMessageEntry(
    itemId: string,
    documentId: DocumentId,
    entry: PullSyncMessagesResponse['messages'][number],
  ): Promise<{ parsed: boolean; cursor?: number }> {
    if (!entry?.encryptedMessage?.iv || !entry?.encryptedMessage?.cipher) {
      return { parsed: false }
    }

    try {
      const decrypted = await decryptBytesWithKey(getVaultKey(), entry.encryptedMessage)
      const isBatched = entry.encryptedMessage.version === '1.0'

      if (isBatched) {
        this.parseBatchedMessages(itemId, documentId, decrypted)
      } else {
        this.onMessageParsed(itemId, documentId, decrypted)
      }

      return { parsed: true, cursor: entry.cursor }
    } catch (error) {
      reportDecryptionFailure({
        itemId,
        error
      })
      return { parsed: false, cursor: entry.cursor }
    }
  }

  getAllCursors(): Array<{ itemId: string; cursor: number }> {
    const cursors: Array<{ itemId: string; cursor: number }> = []

    // Always include the account index so we discover new items from other devices
    const indexCursor = this.cursorByItemId.get(ACCOUNT_INDEX_DOCUMENT_ID) ?? 0
    this.cursorByItemId.set(ACCOUNT_INDEX_DOCUMENT_ID, indexCursor)
    cursors.push({ itemId: ACCOUNT_INDEX_DOCUMENT_ID, cursor: indexCursor })

    // Only include cursors for pending item IDs
    for (const itemId of this.pendingPullItemIds) {
      if (itemId === ACCOUNT_INDEX_DOCUMENT_ID) continue
      const cursor = this.cursorByItemId.get(itemId) ?? 0
      cursors.push({ itemId, cursor })
    }

    return cursors
  }

  async processPullResults(results: PullSyncMessagesResponse[]): Promise<void> {
    if (!this.account) return

    const successfullyPulledItemIds = new Set<string>()
    let cursorsUpdated = false

    try {
      for (const result of results || []) {
        const itemId = result.itemId
        const hasMore = result.hasMore === true
        let highestCursor = this.cursorByItemId.get(itemId) || 0

        const documentId = interpretAsDocumentId(await toAutomergeUrlFromItemId(itemId))

        for (const entry of result.messages || []) {
          const handled = await this.handleMessageEntry(itemId, documentId as DocumentId, entry)
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
      }

      if (cursorsUpdated) {
        this.saveCursorsDebounced()
      }
    } catch (error) {
      console.error('[SyncPullQueueManager] Pull sync batch failed', error)
      throw error
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

  processPushResults(results: Array<{ itemId: string; cursor: number }>): void {
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
}
