import { chunk } from 'lodash-es'

import { getActiveSessionToken } from './workerAuthStore'
import { pollSyncBatchWithToken } from '../api/vault/SyncWorkerClient'
import { encryptBytes } from 'src/api/vault'
import { loadSyncBatch, removeSentSyncMessages } from './VaultPersistence'
import type { SyncPullQueueManager } from './SyncPullQueueManager'


export type PollOutcome = 'success' | 'failure' | 'auth-failure'

export interface SyncPollerCallbacks {
  onStartRequest?: () => void
  onFinishRequest?: () => void
  onSnapshotNeeded?: (cursor: number, requestedAt: number) => void
  onAuthFailure?: (message: string) => void
  onPollResult?: (outcome: PollOutcome) => void
}

export class SyncPoller {
  private account: string | null = null
  private isOnline = true
  private isLeader = false
  private isPolling = false
  private pollingPausedForAuth = false

  private pollIntervalId: number | null = null
  private syncBatchTimeout: number | null = null
  private readonly pollBackoffStepsMs = [30000, 60000, 120000, 300000]
  private pollBackoffIndex = 0
  private nextPollAt = 0

  constructor(
    private pullQueueManager: SyncPullQueueManager,
    private callbacks: SyncPollerCallbacks,
    private persistPendingWrites: () => Promise<void>
  ) {}

  setAccount(account: string | null): void {
    this.account = account
    this.pollingPausedForAuth = false
    this.resetPollBackoff()

    if (this.account && this.isLeader) {
      this.startPolling(true)
    } else {
      this.stopPolling()
    }
  }

  setLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader
    if (this.isLeader && this.account) {
      this.startPolling(true)
    } else {
      this.stopPolling()
    }
  }

  setOnlineState(isOnline: boolean): void {
    if (this.isOnline === isOnline) {
      return
    }
    this.isOnline = isOnline

    if (!isOnline) {
      this.stopPolling()
      return
    }

    if (this.account && this.isLeader) {
      this.resetPollBackoff()
      this.startPolling(true)
    }
  }

  flush(): void {
    if (this.syncBatchTimeout === null) {
      this.syncBatchTimeout = self.setTimeout(
        () => void this.flushSyncBatch(),
        0,
      )
    }
  }

  private async flushSyncBatch(): Promise<void> {
    await this.persistPendingWrites()

    if (this.isPolling) {
      this.syncBatchTimeout = self.setTimeout(() => void this.flushSyncBatch(), 500)
    } else {
      void this.executeWrappedPoll()
      this.syncBatchTimeout = null
    }
  }

  startPolling(immediate?: boolean): void {
    this.stopPolling()

    if (!this.isLeader) {
      return
    }

    if (immediate) {
      void this.executeWrappedPoll()
    }

    this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
  }

  stopPolling(): void {
    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
      this.pollIntervalId = null
    }
    if (this.syncBatchTimeout) {
      self.clearTimeout(this.syncBatchTimeout)
      this.syncBatchTimeout = null
    }
    this.nextPollAt = 0
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.pollingPausedForAuth || !this.isOnline || !this.isLeader) {
      return
    }

    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
    }

    const jitteredDelayMs = this.applyBackoffJitter(delayMs)
    this.nextPollAt = jitteredDelayMs > 0 ? Date.now() + jitteredDelayMs : 0
    this.pollIntervalId = self.setTimeout(() => {
      void this.executeWrappedPoll()
    }, jitteredDelayMs)
  }

  private applyBackoffJitter(delayMs: number): number {
    const jitterWindow = Math.min(15000, Math.floor(delayMs * 0.25))
    if (jitterWindow <= 0) {
      return delayMs
    }

    const offset = Math.floor(Math.random() * (jitterWindow + 1))
    return delayMs + offset
  }

  private resetPollBackoff(): void {
    this.pollBackoffIndex = 0
  }

  private increasePollBackoff(): void {
    this.pollBackoffIndex = Math.min(
      this.pollBackoffIndex + 1,
      this.pollBackoffStepsMs.length - 1,
    )
  }

  private async executeWrappedPoll(): Promise<void> {
    if (this.isPolling || this.pollingPausedForAuth || !this.isOnline) return
    if (this.nextPollAt > 0 && Date.now() < this.nextPollAt) return
    this.isPolling = true

    let outcome: PollOutcome
    try {
      outcome = await this.executePoll()
    } finally {
      this.isPolling = false
    }

    if (this.pollingPausedForAuth) {
      return
    }

    if (outcome === 'auth-failure') {
      this.pollingPausedForAuth = true
      this.stopPolling()
      this.callbacks.onAuthFailure?.('Sync paused: your session has expired. Please sign in again.')
      this.callbacks.onPollResult?.(outcome)
      return
    }

    if (outcome === 'failure') {
      this.increasePollBackoff()
    } else {
      this.resetPollBackoff()
    }

    this.callbacks.onPollResult?.(outcome)

    if (outcome === 'success' && this.pullQueueManager.hasPendingPulls()) {
      this.scheduleNextPoll(0)
    } else {
      this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
    }
  }

  private async executePoll(): Promise<PollOutcome> {
    if (!this.account || !this.isOnline) return 'success'

    const authToken = await getActiveSessionToken()
    if (!authToken) return 'success'

    let batchEntries: [string, Uint8Array[]][]
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

    this.callbacks.onStartRequest?.()
    try {
      if (chunks.length === 0) {
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
          this.callbacks.onSnapshotNeeded?.(response.snapshotRequest.cursor, response.snapshotRequest.requestedAt)
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
          this.callbacks.onSnapshotNeeded?.(response.snapshotRequest.cursor, response.snapshotRequest.requestedAt)
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
      this.callbacks.onFinishRequest?.()
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
