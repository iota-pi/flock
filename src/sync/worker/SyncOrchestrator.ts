import { LeaderElection } from './utils/LeaderElection'
import { SyncMessageBroker } from './SyncMessageBroker'
import type { PollOutcome } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import type { SyncPullQueueManager } from './SyncPullQueueManager'


export class SyncOrchestrator {
  private leaderElection: LeaderElection | null = null
  private isOnline = true
  private isLeader = false
  private isPolling = false
  private pollingPausedForAuth = false
  private isShutdown = false

  private pendingFlush = false
  private activePollPromise: Promise<void> | null = null
  private cursorReloadPromise: Promise<void> | null = null

  private pollIntervalId: number | null = null
  private syncBatchTimeout: number | null = null
  private readonly pollBackoffStepsMs = [30000, 60000, 120000, 300000]
  private pollBackoffIndex = 0

  constructor(
    private accountId: string,
    private broker: SyncMessageBroker,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private pullQueueManager?: SyncPullQueueManager
  ) {
    this.broker.onFlushNeeded = () => {
      this.flush()
    }
    // Sync initial states with the broker
    this.broker.setOnlineState(this.isOnline)
    this.broker.setSendEnabled(this.isLeader)
  }

  async start(): Promise<void> {
    this.leaderElection = new LeaderElection(this.accountId, {
      onLeaderGranted: () => {
        this.setLeader(true)
      },
      onLeaderRevoked: () => {
        this.setLeader(false)
      },
      onMultipleLeadersDetected: () => {
        this.internalEventHub.emit({ type: 'multipleLeadersDetected' })
      },
      onSoleLeaderRestored: () => {
        this.internalEventHub.emit({ type: 'soleLeaderRestored' })
      },
    })
    void this.leaderElection.acquire().catch(console.error)
  }

  public onLeaderChange?: (isLeader: boolean) => void

  get leader(): boolean {
    return this.isLeader
  }

  setLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader
    this.broker.setSendEnabled(isLeader)
    this.onLeaderChange?.(isLeader)

    if (isLeader) {
      const reloadPromise = this.reloadCursors()
      this.cursorReloadPromise = reloadPromise.finally(() => {
        if (this.cursorReloadPromise === reloadPromise) {
          this.cursorReloadPromise = null
        }
      })
      this.startPolling(true)
    } else {
      this.cursorReloadPromise = null
      this.stopPolling()
    }
  }

  setOnlineState(isOnline: boolean): void {
    if (this.isOnline === isOnline) {
      return
    }
    this.isOnline = isOnline
    this.broker.setOnlineState(isOnline)

    if (!isOnline) {
      this.stopPolling()
      return
    }

    if (this.isLeader) {
      this.resetPollBackoff()
      this.startPolling(true)
    }
  }

  flush(): void {
    if (this.isShutdown) return
    this.pollingPausedForAuth = false
    if (this.syncBatchTimeout === null) {
      this.syncBatchTimeout = self.setTimeout(
        () => void this.flushSyncBatch(),
        0
      )
    }
  }

  private async flushSyncBatch(): Promise<void> {
    this.syncBatchTimeout = null
    if (!this.isPolling) {
      void this.executeWrappedPoll(true)
    } else {
      this.pendingFlush = true
    }
  }

  startPolling(immediate?: boolean): void {
    if (this.isShutdown) return
    this.stopPolling()

    if (!this.isLeader) {
      return
    }

    this.pollingPausedForAuth = false

    if (immediate) {
      if (!this.isPolling) {
        void this.executeWrappedPoll(true)
      } else {
        this.pendingFlush = true
      }
    } else {
      this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
    }
  }

  stopPolling(): void {
    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
      this.pollIntervalId = null
    }
    if (this.syncBatchTimeout) {
      self.clearTimeout(this.syncBatchTimeout)
      this.syncBatchTimeout = null
      if (!this.isShutdown) {
        this.pendingFlush = true
      }
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.isShutdown || this.pollingPausedForAuth || !this.isOnline || !this.isLeader) {
      return
    }

    if (this.pollIntervalId) {
      self.clearTimeout(this.pollIntervalId)
    }

    const jitteredDelayMs = this.applyBackoffJitter(delayMs)
    this.pollIntervalId = self.setTimeout(() => {
      this.pollIntervalId = null
      void this.executeWrappedPoll()
    }, jitteredDelayMs)
  }

  private applyBackoffJitter(delayMs: number): number {
    const jitterWindow = Math.min(15000, Math.floor(delayMs * 0.25))
    if (jitterWindow <= 0) {
      return delayMs
    }

    const offset = Math.floor(Math.random() * (jitterWindow + 1)) - Math.floor(jitterWindow / 2)
    return Math.max(0, delayMs + offset)
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

  private async executeWrappedPoll(force = false): Promise<void> {
    if (this.isShutdown || this.isPolling || (!force && this.pollingPausedForAuth) || !this.isOnline || !this.isLeader) return
    this.isPolling = true

    const pollTask = async () => {
      let outcome: PollOutcome
      try {
        if (this.cursorReloadPromise) {
          await this.cursorReloadPromise
        }
        if (this.isShutdown || !this.isOnline || !this.isLeader) {
          return
        }
        outcome = await this.broker.executePoll()
      } catch (_) {
        outcome = 'failure'
      } finally {
        this.isPolling = false
      }

      if (this.isShutdown) return

      if (outcome === 'auth-failure') {
        this.pollingPausedForAuth = true
        this.stopPolling()
        this.clientEventHub.emit({ type: 'authFailure', message: 'Sync paused: your session has expired. Please sign in again.' })
        this.internalEventHub.emit({ type: 'pollResult', outcome })
        return
      }

      const wasFlushPending = this.pendingFlush
      this.pendingFlush = false

      if (outcome === 'failure') {
        this.increasePollBackoff()
      } else {
        this.resetPollBackoff()
        this.pollingPausedForAuth = false
      }

      this.internalEventHub.emit({ type: 'pollResult', outcome })

      if (wasFlushPending || (outcome === 'success' && this.broker.hasPendingPulls())) {
        this.scheduleNextPoll(0)
      } else {
        this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
      }
    }

    const currentPoll = pollTask()
    this.activePollPromise = currentPoll
    try {
      await currentPoll
    } finally {
      if (this.activePollPromise === currentPoll) {
        this.activePollPromise = null
      }
    }
  }

  private async reloadCursors(): Promise<void> {
    try {
      if (this.pullQueueManager) {
        await this.pullQueueManager.loadCursors()
      } else if (typeof (this.broker as any).loadCursors === 'function') {
        await (this.broker as any).loadCursors()
      }
    } catch (error) {
      console.error('[SyncOrchestrator] Failed to reload cursors on leader promotion', error)
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true
    this.setLeader(false)
    this.cursorReloadPromise = null
    if (this.leaderElection) {
      this.leaderElection.release()
      this.leaderElection = null
    }
    this.stopPolling()

    this.broker.abortPoll?.()
    if (this.activePollPromise) {
      await this.activePollPromise
    }
  }
}
