import { ClientEventHub } from './SyncEventHub'
import type { SyncStatus } from '../../state/slices/syncSlice'
import type { PollOutcome } from './SyncPoller'

export class SyncStatusManager {
  private status: SyncStatus = 'offline'
  private isOnline = true
  private activeRequests = 0
  private lastPollOutcome: PollOutcome | null = null

  constructor(private clientEventHub: ClientEventHub) {}

  public getStatus(): SyncStatus {
    return this.status
  }

  public reset(isOnline: boolean) {
    this.isOnline = isOnline
    this.activeRequests = 0
    this.lastPollOutcome = null
    this.updateStatus()
  }

  public setOnlineState(isOnline: boolean) {
    this.isOnline = isOnline
    this.updateStatus()
  }

  public startRequest() {
    this.activeRequests++
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
    this.updateStatus()
  }

  private updateStatus() {
    let newStatus: SyncStatus

    if (!this.isOnline || this.lastPollOutcome === 'auth-failure') {
      newStatus = 'offline'
    } else if (this.activeRequests > 0) {
      newStatus = 'syncing'
    } else if (this.lastPollOutcome === 'failure') {
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
