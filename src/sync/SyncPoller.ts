import { chunk } from 'lodash-es'

import { getActiveSessionToken } from './workerAuthStore'
import { encryptBytes } from 'src/api/vault'
import { loadSyncBatch, removeSentSyncMessages } from './VaultPersistence'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { ItemId } from 'src/shared/schemas/items'
import { SyncEventHub } from './SyncEventHub'
import { fetchMetadataWithToken } from '../api/vault/SyncWorkerClient'
import { addAutomergeItemIdsToIndex, getIndexSnapshot, removeAutomergeItemIdsFromIndex, updateLocalLastModified } from './docStore'


export type PollOutcome = 'success' | 'failure' | 'auth-failure'

export class SyncPoller {
  private account: string | null = null
  private isOnline = true
  private isPolling = false

  constructor(
    private pullQueueManager: SyncPullQueueManager,
    private eventHub: SyncEventHub,
  ) {}

  setAccount(account: string | null): void {
    this.account = account
  }

  setOnlineState(isOnline: boolean): void {
    this.isOnline = isOnline
  }

  isCurrentlyPolling(): boolean {
    return this.isPolling
  }

  async executePoll(): Promise<PollOutcome> {
    if (this.isPolling || !this.isOnline || !this.account) return 'success'
    this.isPolling = true

    this.eventHub.emit({ type: 'startRequest' })
    try {
      const authToken = await getActiveSessionToken()
      if (!authToken) return 'success'

      // 1. Fetch server metadata to discover new, modified, or deleted items
      try {
        const serverMeta = await fetchMetadataWithToken({ account: this.account, authToken })
        if (serverMeta && serverMeta.items) {
          const localIndex = await getIndexSnapshot(this.account)
          const localLastModified = localIndex.lastModified || {}
          const localItemIdsSet = new Set(localIndex.itemIds || [])

          const newOrModified: ItemId[] = []
          const toRemoveFromLocal: ItemId[] = []
          const newLocalLastModified: Record<ItemId, number> = {}

          for (const serverItem of serverMeta.items) {
            const itemId = serverItem.itemId
            if (serverItem.deleted) {
              if (localItemIdsSet.has(itemId)) {
                toRemoveFromLocal.push(itemId)
              }
            } else {
              const localTime = localLastModified[itemId] || 0
              if (!localItemIdsSet.has(itemId) || serverItem.modified > localTime) {
                newOrModified.push(itemId)
                newLocalLastModified[itemId] = serverItem.modified
              }
            }
          }

          let indexChanged = false
          if (newOrModified.length > 0) {
            await addAutomergeItemIdsToIndex(this.account, newOrModified)
            await updateLocalLastModified(this.account, newLocalLastModified)
            for (const id of newOrModified) {
              this.pullQueueManager.addPendingItem(id)
            }
            indexChanged = true
          }

          if (toRemoveFromLocal.length > 0) {
            await removeAutomergeItemIdsFromIndex(this.account, toRemoveFromLocal)
            indexChanged = true
          }

          if (indexChanged) {
            const updatedIndex = await getIndexSnapshot(this.account)
            this.eventHub.emit({ type: 'indexUpdated', itemIds: updatedIndex.itemIds || [] })
            this.eventHub.emit({ type: 'metadataUpdated', metadata: updatedIndex.metadata || {} })
          }
        }
      } catch (err) {
        console.error('[SyncPoller] Failed to check server metadata for discovery:', err)
      }

      let batchEntries: [ItemId, Uint8Array[]][]
      try {
        batchEntries = await loadSyncBatch(this.account)
      } catch (_) {
        return 'failure'
      }

      const chunks = chunk(batchEntries, 5)
      const pullCursors = this.pullQueueManager.getAllCursors()
      if (chunks.length === 0 && pullCursors.length === 0) {
        return 'success'
      }

      if (chunks.length === 0) {
        const { pollSyncBatchWithToken } = await import('../api/vault/SyncWorkerClient')
        const response = await pollSyncBatchWithToken({
          account: this.account,
          authToken,
          pushMessages: [],
          pullCursors
        })

        if (response && response.pushResults) {
          this.pullQueueManager.processPushResults(response.pushResults)
        }

        if (response && response.pullResults) {
          await this.pullQueueManager.processPullResults(response.pullResults)
        }

        if (response?.snapshotRequest?.requested) {
          this.eventHub.emit({
            type: 'snapshotNeeded',
            cursor: response.snapshotRequest.cursor,
            requestedAt: response.snapshotRequest.requestedAt,
          })
        }

        return 'success'
      }

      let isFirstChunk = true
      for (const chunkEntry of chunks) {
        const pushMessages = await Promise.all(
          chunkEntry.map(async ([itemId, messages]) => {
            let totalLength = 0
            for (const m of messages) {
              totalLength += 4 + m.length
            }
            const combined = new Uint8Array(totalLength)
            const view = new DataView(combined.buffer)
            let offset = 0
            for (const m of messages) {
              view.setUint32(offset, m.length, false)
              offset += 4
              combined.set(m, offset)
              offset += m.length
            }

            const encryptedMessage = await encryptBytes(combined)
            return {
              itemId,
              encryptedMessage: {
                iv: encryptedMessage.iv,
                cipher: encryptedMessage.cipher,
                kver: encryptedMessage.kver,
                version: '1.0',
              }
            }
          })
        )

        const { pollSyncBatchWithToken } = await import('../api/vault/SyncWorkerClient')
        const response = await pollSyncBatchWithToken({
          account: this.account,
          authToken,
          pushMessages,
          pullCursors: isFirstChunk ? pullCursors : []
        })
        isFirstChunk = false

        if (response && response.pushResults) {
          this.pullQueueManager.processPushResults(response.pushResults)
        }

        if (response && response.pullResults) {
          await this.pullQueueManager.processPullResults(response.pullResults)
        }

        if (response?.snapshotRequest?.requested) {
          this.eventHub.emit({
            type: 'snapshotNeeded',
            cursor: response.snapshotRequest.cursor,
            requestedAt: response.snapshotRequest.requestedAt,
          })
        }

        await removeSentSyncMessages(this.account, chunkEntry)
      }

      return 'success'
    } catch (error) {
      if (this.isAuthError(error)) {
        console.error('[SyncPoller] Auth failure during polling', error)
        return 'auth-failure'
      }

      console.error('[SyncPoller] Polling failed', error)
      return 'failure'
    } finally {
      this.isPolling = false
      this.eventHub.emit({ type: 'finishRequest' })
    }
  }

  private isAuthError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false
    }

    const anyError = error as { [key: string]: unknown }
    const data = (anyError.data || (anyError as { shape?: { data?: unknown } }).shape?.data) as
      | { httpStatus?: number; code?: string }
      | undefined
    const httpStatus = data?.httpStatus
    if (httpStatus === 401 || httpStatus === 403) {
      return true
    }

    const code = data?.code || (anyError.code as string | undefined)
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      return true
    }

    const message = typeof (anyError as { message?: unknown }).message === 'string'
      ? ((anyError as { message: string }).message).toLowerCase()
      : ''
    return message.includes('unauthorized') || message.includes('forbidden')
  }
}
