import { LeaderElection } from './utils/LeaderElection'
import type { SyncMessageBroker } from './SyncMessageBroker'
import type { PollOutcome } from './SyncPoller'
import { ClientEventHub, WorkerInternalEventHub } from './SyncEventHub'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { RetryStrategy, DEFAULT_POLL_BACKOFF_DELAYS } from '../utils/RetryStrategy'
import { checkAlive, isAbortError } from './utils/abort'
import type { ItemId } from 'src/shared/schemas/items'

export interface SyncPollerLike {
  executePoll: () => Promise<PollOutcome>
  abort?: () => void
}

export interface SyncPullQueueManagerLike {
  loadCursors: () => Promise<void>
  hasImmediatePendingPulls?: () => boolean
  hasPendingPulls?: () => boolean
}

export interface ManifestSyncManagerLike {
  sync: (force?: boolean, signal?: AbortSignal) => Promise<{ added: ItemId[] }>
  abort?: () => void
}

export interface SyncOrchestratorOptions {
  manifestSyncIntervalMs?: number
}

const DEFAULT_MANIFEST_SYNC_INTERVAL_MS = 60 * 60 * 1000

export class SyncOrchestrator {
  private leaderElection: LeaderElection | null = null
  private isOnline = true
  private isLeader = false
  private pollingPausedForAuth = false
  private isShutdown = false

  private pendingFlush = false
  private readonly pollGuard = new SingleFlightGuard<void>()
  private readonly cursorReloadGuard = new SingleFlightGuard<void>()
  private pollAbortController: AbortController | null = null
  private manifestSyncAbortController: AbortController | null = null
  private poller: SyncPollerLike

  private pollIntervalId: number | null = null
  private syncBatchTimeout: number | null = null
  private readonly pollBackoff = new RetryStrategy({
    delays: DEFAULT_POLL_BACKOFF_DELAYS,
    jitter: { factor: 0.25, maxJitterMs: 15000 },
  })

  private get pollBackoffIndex(): number {
    return this.pollBackoff.attempt
  }

  private set pollBackoffIndex(val: number) {
    this.pollBackoff.attempt = val
  }

  private get pollBackoffStepsMs(): readonly number[] {
    return this.pollBackoff.delays
  }

  private manifestSyncIntervalId: number | null = null
  private readonly manifestSyncIntervalMs: number
  private readonly manifestSyncGuard = new SingleFlightGuard<void>()
  private manifestSyncManager: ManifestSyncManagerLike | null = null

  private unsubscribeInternalEvents: (() => void) | null = null

  constructor(
    private accountId: string,
    private broker: SyncMessageBroker,
    private clientEventHub: ClientEventHub,
    private internalEventHub: WorkerInternalEventHub,
    private pullQueueManager: SyncPullQueueManagerLike,
    manifestSyncManager?: ManifestSyncManagerLike,
    options?: SyncOrchestratorOptions
  ) {
    this.poller = broker.poller
    this.manifestSyncManager = manifestSyncManager ?? null
    this.manifestSyncIntervalMs = options?.manifestSyncIntervalMs ?? DEFAULT_MANIFEST_SYNC_INTERVAL_MS
    this.unsubscribeInternalEvents = this.internalEventHub.subscribe(event => {
      if (event.type === 'flushNeeded') {
        this.flush()
      }
    })
    // Sync initial states with the broker
    this.broker?.setOnlineState?.(this.isOnline)
    this.broker?.setSendEnabled?.(this.isLeader)
  }

  get isOperational(): boolean {
    return !this.isShutdown && this.isOnline && this.isLeader
  }

  get isPolling(): boolean {
    return this.pollGuard.isRunning
  }

  private canPoll(force = false): boolean {
    return this.isOperational && (force || !this.pollingPausedForAuth)
  }

  private abortPoll(): void {
    if (this.pollAbortController) {
      this.pollAbortController.abort()
      this.pollAbortController = null
      this.poller.abort?.()
    }
  }

  private abortManifestSync(): void {
    if (this.manifestSyncAbortController) {
      this.manifestSyncAbortController.abort()
      this.manifestSyncAbortController = null
    }
    this.manifestSyncManager?.abort?.()
  }

  setManifestSyncManager(manifestSyncManager: ManifestSyncManagerLike): void {
    this.manifestSyncManager = manifestSyncManager
    if (this.isOperational) {
      this.startPeriodicManifestSync()
      void this.triggerManifestSync()
    }
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
      onLeaderConflict: (isConflict: boolean) => {
        this.internalEventHub.emit({ type: 'leaderConflict', hasConflict: isConflict })
        this.clientEventHub.emit({ type: 'leaderConflict', hasConflict: isConflict })
      },
    })
    void this.leaderElection.acquire().catch(console.error)
  }

  claimLeader(): void {
    this.leaderElection?.claimLeadership()
  }

  get leader(): boolean {
    return this.isLeader
  }

  get online(): boolean {
    return this.isOnline
  }

  setLeader(isLeader: boolean): void {
    if (this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader
    this.broker.setSendEnabled(isLeader)
    this.internalEventHub.emit({ type: 'leaderChange', isLeader })

    if (isLeader) {
      void this.cursorReloadGuard.run(() => this.reloadCursors())
      this.startPolling(true)
      if (this.isOnline) {
        this.startPeriodicManifestSync()
        void this.triggerManifestSync()
      }
    } else {
      this.cursorReloadGuard.clear()
      this.stopPolling()
      this.stopPeriodicManifestSync()
      this.abortPoll()
      this.abortManifestSync()
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
      this.stopPeriodicManifestSync()
      this.abortPoll()
      this.abortManifestSync()
      return
    }

    if (this.isLeader) {
      this.resetPollBackoff()
      this.startPolling(true)
      this.startPeriodicManifestSync()
      void this.triggerManifestSync()
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
    if (this.pollGuard.isRunning) {
      this.pendingFlush = true
      return
    }

    if (this.pollBackoffIndex > 0) {
      if (this.pollIntervalId === null) {
        this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
      }
      return
    }

    void this.executeWrappedPoll(true)
  }

  startPolling(immediate?: boolean): void {
    if (this.isShutdown) return
    this.stopPolling()

    if (!this.isLeader) {
      return
    }

    this.pollingPausedForAuth = false

    if (immediate) {
      if (!this.pollGuard.isRunning) {
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
    if (!this.canPoll()) {
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
    return this.pollBackoff.applyJitter(delayMs)
  }

  private resetPollBackoff(): void {
    this.pollBackoff.reset()
  }

  private increasePollBackoff(): void {
    this.pollBackoff.increment({ clampToLast: true })
  }

  private async executeWrappedPoll(force = false): Promise<void> {
    if (!this.canPoll(force) || this.pollGuard.isRunning) return

    const pollTask = async () => {
      const abortController = new AbortController()
      this.pollAbortController = abortController
      const { signal } = abortController

      let outcome: PollOutcome
      try {
        if (this.cursorReloadGuard.isRunning) {
          await this.cursorReloadGuard.waitForRunning()
        }
        checkAlive(signal, () => this.isOperational)

        outcome = await this.poller.executePoll()
        checkAlive(signal, () => this.isOperational)
      } catch (err) {
        if (signal.aborted || isAbortError(err)) {
          return
        }
        outcome = 'failure'
      } finally {
        if (this.pollAbortController === abortController) {
          this.pollAbortController = null
        }
      }

      if (signal.aborted || !this.isOperational) {
        return
      }

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

      const hasMorePulls = this.pullQueueManager.hasImmediatePendingPulls
        ? this.pullQueueManager.hasImmediatePendingPulls()
        : Boolean(this.pullQueueManager.hasPendingPulls?.())

      if (outcome === 'failure') {
        this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
      } else if (
        wasFlushPending ||
        (outcome === 'success' && hasMorePulls)
      ) {
        this.scheduleNextPoll(0)
      } else {
        this.scheduleNextPoll(this.pollBackoffStepsMs[this.pollBackoffIndex])
      }
    }

    await this.pollGuard.run(pollTask, {
      onCoalesce: () => {
        this.pendingFlush = true
      },
    })
  }

  private async reloadCursors(): Promise<void> {
    try {
      await this.pullQueueManager.loadCursors()
    } catch (error) {
      console.error('[SyncOrchestrator] Failed to reload cursors on leader promotion', error)
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true
    if (this.unsubscribeInternalEvents) {
      this.unsubscribeInternalEvents()
      this.unsubscribeInternalEvents = null
    }
    const wasPolling = this.pollAbortController !== null
    this.setLeader(false)
    this.cursorReloadGuard.clear()
    if (this.leaderElection) {
      this.leaderElection.release()
      this.leaderElection = null
    }
    this.stopPolling()
    this.stopPeriodicManifestSync()

    this.abortPoll()
    this.abortManifestSync()
    if (!wasPolling) {
      this.poller.abort?.()
    }
    await this.pollGuard.waitForRunning()
    await this.manifestSyncGuard.waitForRunning()
  }

  startPeriodicManifestSync(): void {
    if (!this.isOperational) {
      return
    }
    this.stopPeriodicManifestSync()
    this.manifestSyncIntervalId = self.setInterval(() => {
      void this.triggerManifestSync()
    }, this.manifestSyncIntervalMs) as unknown as number
  }

  stopPeriodicManifestSync(): void {
    if (this.manifestSyncIntervalId !== null) {
      self.clearInterval(this.manifestSyncIntervalId)
      this.manifestSyncIntervalId = null
    }
  }

  async triggerManifestSync(force = false): Promise<void> {
    if (!this.isOperational || !this.manifestSyncManager) {
      return
    }
    return this.manifestSyncGuard.run(async () => {
      const abortController = new AbortController()
      this.manifestSyncAbortController = abortController
      const { signal } = abortController
      try {
        checkAlive(signal, () => this.isOperational)
        await this.manifestSyncManager!.sync(force, signal)
        checkAlive(signal, () => this.isOperational)
      } catch (error) {
        if (signal.aborted || isAbortError(error) || !this.isOperational) {
          return
        }
        console.warn('[SyncOrchestrator] Manifest sync failed', error)
      } finally {
        if (this.manifestSyncAbortController === abortController) {
          this.manifestSyncAbortController = null
        }
      }
    })
  }
}
