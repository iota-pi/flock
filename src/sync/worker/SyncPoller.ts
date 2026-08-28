import { chunk } from 'lodash-es'

import { getActiveSessionToken } from '../shared/workerAuthStore'
import { encryptBytes } from '../../api/vault'
import { loadSyncBatch, removeSentSyncMessages, type QueuedMessage } from '../shared/VaultPersistence'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { ItemId } from 'src/shared/schemas/items'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'

export class SyncPoller {
  private account: string | null = null
  private isOnline = true
  private isPolling = false

  constructor(
    private pullQueueManager: SyncPullQueueManager,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private indexManager: AutomergeIndexManager,
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
    if (this.isPolling || !this.isOnline || !this.account) return 'no-poll'
    this.isPolling = true

    this.clientEventHub.emit({ type: 'startRequest' })
    try {
      const authToken = await getActiveSessionToken()
      if (!authToken) return 'no-poll'

      let batchEntries: [ItemId, QueuedMessage[]][]
      try {
        batchEntries = await loadSyncBatch(this.account)
      } catch (_) {
        return 'failure'
      }

      const chunks = chunk(batchEntries, 5)
      const pullCursors = this.pullQueueManager.getCursors()

      if (chunks.length === 0) {
        const { pollSyncBatchWithToken } = await import('../../api/vault/SyncWorkerClient')
        const response = await pollSyncBatchWithToken({
          account: this.account,
          authToken,
          pushMessages: [],
          pullCursors,
          clientLatestCursor: this.pullQueueManager.getGlobalLatestCursor(),
        })

        if (response && response.pushResults) {
          this.pullQueueManager.processPushResults(response.pushResults)
        }

        if (response && response.pullResults) {
          await this.pullQueueManager.processPullResults(response.pullResults)
        }

        if (response?.snapshotRequest?.requested) {
          this.internalEventHub.emit({
            type: 'snapshotNeeded',
            cursor: response.snapshotRequest.cursor,
            requestedAt: response.snapshotRequest.requestedAt,
          })
        }

        await this.indexManager.updateLastSyncTime(Date.now())
        return 'success'
      }

      let highestSnapshotRequest: { cursor: number; requestedAt: number } | null = null
      for (const chunkEntry of chunks) {
        const pushMessages = await Promise.all(
          chunkEntry.map(async ([itemId, messages]) => {
            let totalLength = 0
            for (const m of messages) {
              totalLength += 4 + m.data.length
            }
            const combined = new Uint8Array(totalLength)
            const view = new DataView(combined.buffer)
            let offset = 0
            for (const m of messages) {
              view.setUint32(offset, m.data.length, false)
              offset += 4
              combined.set(m.data, offset)
              offset += m.data.length
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

        const { pollSyncBatchWithToken } = await import('../../api/vault/SyncWorkerClient')
        const response = await pollSyncBatchWithToken({
          account: this.account,
          authToken,
          pushMessages,
          pullCursors: this.pullQueueManager.getCursors(),
          clientLatestCursor: this.pullQueueManager.getGlobalLatestCursor(),
        })

        if (response && response.pushResults) {
          this.pullQueueManager.processPushResults(response.pushResults)
        }

        if (response && response.pullResults) {
          await this.pullQueueManager.processPullResults(response.pullResults)
        }

        if (response?.snapshotRequest?.requested) {
          if (!highestSnapshotRequest || response.snapshotRequest.cursor > highestSnapshotRequest.cursor) {
            highestSnapshotRequest = {
              cursor: response.snapshotRequest.cursor,
              requestedAt: response.snapshotRequest.requestedAt,
            }
          }
        }

        await removeSentSyncMessages(this.account, chunkEntry)
      }

      if (highestSnapshotRequest) {
        this.internalEventHub.emit({
          type: 'snapshotNeeded',
          cursor: highestSnapshotRequest.cursor,
          requestedAt: highestSnapshotRequest.requestedAt,
        })
      }

      await this.indexManager.updateLastSyncTime(Date.now())
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
      this.clientEventHub.emit({ type: 'finishRequest' })
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
    const httpStatus = data?.httpStatus ?? (anyError.httpStatus as number | undefined) ?? (anyError.status as number | undefined) ?? (anyError.statusCode as number | undefined)
    if (httpStatus === 401 || httpStatus === 403) {
      return true
    }

    const code = data?.code ?? (anyError.code as string | undefined)
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
      return true
    }

    if (anyError.cause && typeof anyError.cause === 'object') {
      const cause = anyError.cause as { [key: string]: unknown }
      const causeStatus = (cause.status ?? cause.statusCode ?? cause.httpStatus) as number | undefined
      if (causeStatus === 401 || causeStatus === 403) {
        return true
      }
      const causeCode = cause.code as string | undefined
      if (causeCode === 'UNAUTHORIZED' || causeCode === 'FORBIDDEN') {
        return true
      }
    }

    const name = anyError.name as string | undefined
    if (name === 'UnauthorizedError' || name === 'ForbiddenError') {
      return true
    }

    return false
  }
}
