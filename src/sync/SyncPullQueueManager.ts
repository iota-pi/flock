import { pullSyncBatch } from '../api/vault/httpSyncTransport'
import { decryptSyncMessage } from './automergeSyncCrypto'
import { reportDecryptionFailure } from '../api/syncHealthCoordinator'
import { toAutomergeUrlFromItemId, toVaultItemIdFromAutomergeId } from './automergeRepoIds'
import { publishRealtimeBusSyncPing } from './realtimeBus'
import { interpretAsDocumentId, type DocumentId } from '@automerge/automerge-repo/slim'

const RETRY_PULL_DELAY_MS = 750

export class SyncPullQueueManager {
  private account: string | null = null
  private readonly pendingPullItemIds = new Set<string>()
  private readonly cursorByItemId = new Map<string, number>()
  private isPulling = false
  private pullRetryTimeoutId: ReturnType<typeof setTimeout> | null = null

  public onMessageParsed: (itemId: string, documentId: DocumentId, message: Uint8Array) => void = () => {}

  setAccount(account: string | null): void {
    this.account = account
    this.pendingPullItemIds.clear()
    this.cursorByItemId.clear()
    this.clearPullRetryTimeout()
  }

  clear(): void {
    this.pendingPullItemIds.clear()
    this.cursorByItemId.clear()
    this.clearPullRetryTimeout()
  }

  removeKnownItemIds(itemIds: string[]): void {
    for (const itemId of itemIds) {
      this.pendingPullItemIds.delete(itemId)
      this.cursorByItemId.delete(itemId)
    }
  }

  async enqueuePull(itemIds: string[]): Promise<void> {
    for (const itemId of itemIds) {
      if (itemId.length > 0) {
        this.pendingPullItemIds.add(itemId)
      }
    }

    if (itemIds.length > 0) {
      this.clearPullRetryTimeout()
    }

    if (this.isPulling) {
      return
    }

    this.isPulling = true
    try {
      await this.flushPullQueue()
    } finally {
      this.isPulling = false
      if (this.pendingPullItemIds.size > 0) {
        this.schedulePullRetry()
      }
    }
  }

  private schedulePullRetry(): void {
    if (this.pullRetryTimeoutId !== null) return
    this.pullRetryTimeoutId = setTimeout(() => {
      this.pullRetryTimeoutId = null
      this.enqueuePull([])
    }, RETRY_PULL_DELAY_MS)
  }

  private clearPullRetryTimeout(): void {
    if (this.pullRetryTimeoutId === null) return
    clearTimeout(this.pullRetryTimeoutId)
    this.pullRetryTimeoutId = null
  }

  private async flushPullQueue(): Promise<void> {
    if (!this.account) {
      this.pendingPullItemIds.clear()
      return
    }

    const queued = Array.from(this.pendingPullItemIds)
    this.pendingPullItemIds.clear()

    if (queued.length === 0) return

    const successfullyPulledItemIds = new Set<string>()

    try {
      const response = await pullSyncBatch({
        account: this.account,
        cursors: queued.map(itemId => ({
          itemId,
          cursor: this.cursorByItemId.get(itemId) || 0,
        })),
      })

      for (const result of response.results || []) {
        const itemId = toVaultItemIdFromAutomergeId(result.itemId)
        let highestCursor = this.cursorByItemId.get(itemId) || 0

        for (const entry of result.messages || []) {
          if (!entry?.encryptedMessage?.iv || !entry?.encryptedMessage?.cipher) continue

          try {
            const decrypted = await decryptSyncMessage(entry.encryptedMessage)
            const documentId = interpretAsDocumentId(toAutomergeUrlFromItemId(itemId))

            this.onMessageParsed(itemId, documentId as DocumentId, decrypted)
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

        if (highestCursor > 0) {
          this.cursorByItemId.set(itemId, highestCursor)
        }
      }
    } catch (error) {
      console.error('[SyncPullQueueManager] Pull sync batch failed', error)
      for (const itemId of queued) {
        this.pendingPullItemIds.add(itemId)
      }
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
}
