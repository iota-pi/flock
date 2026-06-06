import { LeaderElection } from './utils/LeaderElection'
import { VaultEncryptedNetworkAdapter } from '../sync/VaultEncryptedNetworkAdapter'
import type { PollOutcome } from '../sync/SyncPoller'
import type { SyncStatus } from 'src/state/syncStore'

export interface SyncOrchestratorCallbacks {
  onStatusChange: (status: SyncStatus) => void
  onAuthFailure: (message: string) => void
  onPollResult: (outcome: PollOutcome) => void
}

export class SyncOrchestrator {
  private leaderElection: LeaderElection | null = null
  private isOnline = true
  private isLeader = false
  private isPolling = false
  private pollingPausedForAuth = false

  private pollIntervalId: any = null
  private syncBatchTimeout: any = null
  private readonly pollBackoffStepsMs = [30000, 60000, 120000, 300000]
  private pollBackoffIndex = 0
  private nextPollAt = 0

  constructor(
    private accountId: string,
    private adapter: VaultEncryptedNetworkAdapter,
    private callbacks: SyncOrchestratorCallbacks
  ) {
    this.adapter.onFlushNeeded = () => {
      this.flush()
    }
    // Sync initial states with the adapter
    this.adapter.setOnlineState(this.isOnline)
    this.adapter.setSendEnabled(this.isLeader)
  }

  async start(): Promise<void> {
    this.leaderElection = new LeaderElection(this.accountId, {
      onLeaderGranted: () => {
        this.setLeader(true)
      },
      onLeaderRevoked: () => {
        this.setLeader(false)
      }
    })
    void this.leaderElection.acquire().catch(console.error)
  }

  setLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader
    this.adapter.setSendEnabled(isLeader)

    if (isLeader) {
      if (this.isOnline) {
        this.callbacks.onStatusChange('idle')
      }
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
    this.adapter.setOnlineState(isOnline)

    if (!isOnline) {
      this.stopPolling()
      this.callbacks.onStatusChange('offline')
      return
    }

    if (this.isLeader) {
      this.resetPollBackoff()
      this.startPolling(true)
      this.callbacks.onStatusChange('idle')
    } else {
      this.callbacks.onStatusChange('offline')
    }
  }

  flush(): void {
    if (this.syncBatchTimeout === null) {
      this.syncBatchTimeout = self.setTimeout(
        () => void this.flushSyncBatch(),
        0
      )
    }
  }

  private async flushSyncBatch(): Promise<void> {
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
      this.pollBackoffStepsMs.length - 1
    )
  }

  private async executeWrappedPoll(): Promise<void> {
    if (this.isPolling || this.pollingPausedForAuth || !this.isOnline || !this.isLeader) return
    if (this.nextPollAt > 0 && Date.now() < this.nextPollAt) return
    this.isPolling = true

    let outcome: PollOutcome
    try {
      outcome = await this.adapter.executePoll()
    } catch (error) {
      outcome = 'failure'
    } finally {
      this.isPolling = false
    }

    if (this.pollingPausedForAuth) {
      return
    }

    if (outcome === 'auth-failure') {
      this.pollingPausedForAuth = true
      this.stopPolling()
      this.callbacks.onAuthFailure('Sync paused: your session has expired. Please sign in again.')
      this.callbacks.onPollResult(outcome)
      return
    }

    if (outcome === 'failure') {
      this.increasePollBackoff()
    } else {
      this.resetPollBackoff()
    }

    this.callbacks.onPollResult(outcome)

    if (outcome === 'success' && this.adapter.hasPendingPulls()) {
      this.scheduleNextPoll(0)
    } else {
      this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
    }
  }

  async shutdown(): Promise<void> {
    if (this.leaderElection) {
      this.leaderElection.release()
      this.leaderElection = null
    }
    this.stopPolling()
  }
}
