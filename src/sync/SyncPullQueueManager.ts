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
    if (!itemId || this.cursorByItemId.has(itemId)) {
      return
    }
    this.pendingPullItemIds.add(itemId)
  }

  getAllCursors(): Array<{ itemId: string; cursor: number }> {
    // Always include the account index so we discover new items from other devices
    if (!this.cursorByItemId.has(ACCOUNT_INDEX_DOCUMENT_ID)) {
      this.cursorByItemId.set(ACCOUNT_INDEX_DOCUMENT_ID, 0)
    }

    const cursors = Array.from(this.cursorByItemId.entries()).map(([itemId, cursor]) => ({
      itemId,
      cursor,
    }))

    // Add pending item IDs that might not have a cursor yet
    for (const itemId of this.pendingPullItemIds) {
      if (!this.cursorByItemId.has(itemId)) {
        cursors.push({ itemId, cursor: 0 })
      }
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
        this.pendingPullItemIds.delete(itemId)
        let highestCursor = this.cursorByItemId.get(itemId) || 0

        for (const entry of result.messages || []) {
          if (!entry?.encryptedMessage?.iv || !entry?.encryptedMessage?.cipher) continue

          try {
            const decrypted = await decryptBytesWithKey(getVaultKey(), entry.encryptedMessage)
            const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))
            const isBatched = entry.encryptedMessage.version === '1.0'

            if (isBatched) {
              let offset = 0
              const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength)
              while (offset < decrypted.byteLength) {
                const length = view.getUint32(offset, false)
                offset += 4
                const msg = new Uint8Array(decrypted.buffer, decrypted.byteOffset + offset, length)
                offset += length

                this.onMessageParsed(itemId, documentId as DocumentId, msg)
              }
            } else {
              this.onMessageParsed(itemId, documentId as DocumentId, decrypted)
            }

            successfullyPulledItemIds.add(itemId)
          } catch (error) {
            reportDecryptionFailure({
              source: 'main-thread',
              itemId: itemId,
              error
            })
          }

          if (Number.isFinite(entry.cursor)) {
            highestCursor = Math.max(highestCursor, entry.cursor)
          }
        }

        if (Number.isFinite(result.nextCursor)) {
          highestCursor = Math.max(highestCursor, result.nextCursor)
        }

        if (highestCursor >= 0) {
          this.cursorByItemId.set(itemId, highestCursor)
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
