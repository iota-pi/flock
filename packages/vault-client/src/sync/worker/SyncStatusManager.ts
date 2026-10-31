import { ClientEventHub } from './SyncEventHub'
import type { SyncStatus } from '../shared/types'
import type { PollOutcome } from './SyncPoller'
import type { SyncSessionState } from './SyncSessionState'

/**
 * Works out the session's sync status and emits `statusChange` when it changes. It's the only place
 * the status is decided while a session runs: the main thread shows what it emits, and sets a status
 * itself only while no worker session can report one (starting, stopped or crashed).
 */
export class SyncStatusManager {
  private status: SyncStatus = 'offline'
  private activeRequests = 0
  private lastPollOutcome: PollOutcome | null = null
  private isQuotaExceeded = false
  private isDegradedPull = false
  /** A snapshot upload failed for good. Cleared by the next successful poll. */
  private hasSnapshotFailure = false

  constructor(
    private readonly clientEventHub: ClientEventHub,
    private readonly session: SyncSessionState,
  ) {}

  public getStatus(): SyncStatus {
    return this.status
  }

  public reset() {
    this.lastPollOutcome = null
    this.isQuotaExceeded = false
    this.isDegradedPull = false
    this.hasSnapshotFailure = false
    this.updateStatus()
  }

  /** Called after the session's online state changed */
  public onOnlineStateChange() {
    this.updateStatus()
  }

  public setQuotaExceeded(exceeded: boolean) {
    this.isQuotaExceeded = exceeded
    this.updateStatus()
  }

  public setDegradedPull(degraded: boolean) {
    this.isDegradedPull = degraded
    this.updateStatus()
  }

  public setSnapshotFailed() {
    this.hasSnapshotFailure = true
    this.updateStatus()
  }

  public startRequest() {
    this.activeRequests += 1
    this.updateStatus()
  }

  public finishRequest() {
    this.activeRequests = Math.max(0, this.activeRequests - 1)
    this.updateStatus()
  }

  public handlePollResult(outcome: PollOutcome) {
    if (outcome !== 'no-poll') {
      this.lastPollOutcome = outcome
    }
    if (outcome === 'success') {
      this.hasSnapshotFailure = false
    }
    this.updateStatus()
  }

  private updateStatus() {
    let newStatus: SyncStatus

    if (!this.session.isOnline || this.lastPollOutcome === 'auth-failure') {
      newStatus = 'offline'
    } else if (this.activeRequests > 0) {
      newStatus = 'syncing'
    } else if (
      this.lastPollOutcome === 'failure'
      || this.isQuotaExceeded
      || this.isDegradedPull
      || this.hasSnapshotFailure
    ) {
      newStatus = 'degraded'
    } else {
      newStatus = 'idle'
    }

    if (this.status !== newStatus) {
      this.status = newStatus
      this.clientEventHub.emit({ type: 'statusChange', status: newStatus })
    }
  }
}
