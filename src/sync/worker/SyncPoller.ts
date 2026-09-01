import { chunk } from 'lodash-es'

import { getActiveSessionToken } from '../shared/workerAuthStore'
import { encryptBytes } from '../../api/vault'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { ItemId } from 'src/shared/schemas/items'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncWriteAheadLog, packBatchedMessages, type WalEntry } from './SyncWriteAheadLog'

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
    private wal?: SyncWriteAheadLog | null,
  ) {}

  setAccount(account: string | null): void {
    this.account = account
  }

  setWal(wal: SyncWriteAheadLog | null): void {
    this.wal = wal
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

      let batchEntries: [ItemId, WalEntry[]][]
      try {
        if (this.wal) {
          const walMap = await this.wal.readAll()
          batchEntries = Array.from(walMap.entries())
        } else {
          batchEntries = []
        }
      } catch (err) {
        console.error('[SyncPoller] Failed to load WAL entries', err)
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
          try {
            this.pullQueueManager.processPushResults(response.pushResults)
          } catch (pushErr) {
            console.error('[SyncPoller] Error processing push results', pushErr)
          }
        }

        if (response && response.pullResults) {
          try {
            await this.pullQueueManager.processPullResults(response.pullResults)
          } catch (pullErr) {
            console.error('[SyncPoller] Error processing pull results', pullErr)
          }
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
        const sentIds: string[] = []
        const pushMessages = await Promise.all(
          chunkEntry.map(async ([itemId, messages]) => {
            for (const m of messages) {
              sentIds.push(m.id)
            }
            const combined = packBatchedMessages(messages)
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

        if (this.wal && sentIds.length > 0) {
          try {
            await this.wal.remove(sentIds)
          } catch (walErr) {
            console.error('[SyncPoller] Failed to remove sent IDs from WAL', walErr)
          }
        }

        if (response && response.pushResults) {
          try {
            this.pullQueueManager.processPushResults(response.pushResults)
          } catch (pushErr) {
            console.error('[SyncPoller] Error processing push results', pushErr)
          }
        }

        if (response && response.pullResults) {
          try {
            await this.pullQueueManager.processPullResults(response.pullResults)
          } catch (pullErr) {
            console.error('[SyncPoller] Error processing pull results', pullErr)
          }
        }

        if (response?.snapshotRequest?.requested) {
          if (!highestSnapshotRequest || response.snapshotRequest.cursor > highestSnapshotRequest.cursor) {
            highestSnapshotRequest = {
              cursor: response.snapshotRequest.cursor,
              requestedAt: response.snapshotRequest.requestedAt,
            }
          }
        }
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
