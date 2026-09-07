import { chunk } from 'lodash-es'

import { getActiveSessionToken } from '../shared/workerAuthStore'
import { encryptBytes } from '../../api/vault'
import type { SyncPullQueueManager } from './SyncPullQueueManager'
import { ItemId } from 'src/shared/schemas/items'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { SyncWriteAheadLog, packBatchedMessages, type WalEntry } from './SyncWriteAheadLog'
import { isAuthError } from './utils/auth'
import { pollSyncBatchWithToken, type PushResultItem } from '../../api/vault/SyncWorkerClient'

export type PollOutcome = 'success' | 'failure' | 'auth-failure' | 'no-poll'

export class SyncPoller {
  private account: string | null = null
  private isOnline = true
  private isPolling = false
  private isShutdown = false
  private abortController: AbortController | null = null

  constructor(
    private pullQueueManager: SyncPullQueueManager,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private indexManager: AutomergeIndexManager,
    private wal?: SyncWriteAheadLog | null,
  ) {}

  setAccount(account: string | null): void {
    this.account = account
    if (account) {
      this.isShutdown = false
    }
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

  abort(): void {
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
  }

  shutdown(): void {
    this.isShutdown = true
    this.abort()
  }

  async executePoll(): Promise<PollOutcome> {
    if (this.isShutdown || this.isPolling || !this.isOnline || !this.account) return 'no-poll'
    this.isPolling = true
    this.abortController = new AbortController()
    const signal = this.abortController.signal

    this.clientEventHub.emit({ type: 'startRequest' })
    try {
      const authToken = await getActiveSessionToken()
      if (this.isShutdown || signal.aborted) return 'no-poll'
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

      if (this.isShutdown || signal.aborted) return 'no-poll'

      const chunks = chunk(batchEntries, 5)
      const pullCursors = this.pullQueueManager.getCursors()

      if (chunks.length === 0) {
        const response = await pollSyncBatchWithToken(
          {
            account: this.account,
            authToken,
            pushMessages: [],
            pullCursors,
            clientLatestCursor: this.pullQueueManager.getGlobalLatestCursor(),
          },
          { signal }
        )

        if (this.isShutdown || signal.aborted) return 'no-poll'

        if (response && response.pushResults) {
          try {
            this.pullQueueManager.processPushResults(response.pushResults)
          } catch (pushErr) {
            console.error('[SyncPoller] Error processing push results', pushErr)
          }
        }

        if (this.isShutdown || signal.aborted) return 'no-poll'

        if (response && response.pullResults) {
          try {
            await this.pullQueueManager.processPullResults(response.pullResults)
          } catch (pullErr) {
            console.error('[SyncPoller] Error processing pull results', pullErr)
          }
        }

        if (this.isShutdown || signal.aborted) return 'no-poll'

        await this.indexManager.updateLastSyncTime(Date.now())
        return 'success'
      }

      for (const chunkEntry of chunks) {
        if (this.isShutdown || signal.aborted) return 'no-poll'

        const sentIdsByItem = new Map<ItemId, string[]>()
        const pushMessages = await Promise.all(
          chunkEntry.map(async ([itemId, messages]) => {
            sentIdsByItem.set(
              itemId,
              messages.map(m => m.id)
            )
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

        if (this.isShutdown || signal.aborted) return 'no-poll'

        const response = await pollSyncBatchWithToken(
          {
            account: this.account,
            authToken,
            pushMessages,
            pullCursors: this.pullQueueManager.getCursors(),
            clientLatestCursor: this.pullQueueManager.getGlobalLatestCursor(),
          },
          { signal }
        )

        if (this.isShutdown || signal.aborted) return 'no-poll'

        const acknowledgedIds: string[] = []
        const acknowledgedItemIds = new Set<ItemId>()

        if (response && Array.isArray(response.pushResults)) {
          for (const result of response.pushResults) {
            if (this.isPushResultSuccessful(result)) {
              acknowledgedItemIds.add(result.itemId)
              const ids = sentIdsByItem.get(result.itemId)
              if (ids && ids.length > 0) {
                acknowledgedIds.push(...ids)
              }
            } else {
              console.warn(`[SyncPoller] Push failed for item ${result.itemId}`, result)
            }
          }
        }

        for (const [sentItemId] of chunkEntry) {
          if (!acknowledgedItemIds.has(sentItemId)) {
            console.warn(`[SyncPoller] Item ${sentItemId} was not acknowledged in pushResults, preserving in WAL`)
          }
        }

        if (this.wal && acknowledgedIds.length > 0) {
          try {
            await this.wal.remove(acknowledgedIds)
          } catch (walErr) {
            console.error('[SyncPoller] Failed to remove acknowledged IDs from WAL', walErr)
          }
        }

        if (this.isShutdown || signal.aborted) return 'no-poll'

        if (response && response.pushResults) {
          try {
            this.pullQueueManager.processPushResults(response.pushResults)
          } catch (pushErr) {
            console.error('[SyncPoller] Error processing push results', pushErr)
          }
        }

        if (this.isShutdown || signal.aborted) return 'no-poll'

        if (response && response.pullResults) {
          try {
            await this.pullQueueManager.processPullResults(response.pullResults)
          } catch (pullErr) {
            console.error('[SyncPoller] Error processing pull results', pullErr)
          }
        }
      }

      if (this.isShutdown || signal.aborted) return 'no-poll'

      await this.indexManager.updateLastSyncTime(Date.now())
      return 'success'
    } catch (error) {
      if (this.isShutdown || signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        return 'no-poll'
      }

      if (this.isAuthError(error)) {
        console.error('[SyncPoller] Auth failure during polling', error)
        return 'auth-failure'
      }

      console.error('[SyncPoller] Polling failed', error)
      return 'failure'
    } finally {
      this.isPolling = false
      this.abortController = null
      this.clientEventHub.emit({ type: 'finishRequest' })
    }
  }

  private isAuthError(error: unknown): boolean {
    return isAuthError(error)
  }

  private isPushResultSuccessful(result: PushResultItem): boolean {
    if (!result || !result.itemId) return false
    if (result.success === false) return false
    if (result.success === true) return true
    return typeof result.cursor === 'number' && Number.isFinite(result.cursor) && result.cursor >= 0
  }
}
