import type { ItemId } from '@vault/shared'
import type { LastModifiedStore } from './stores/LastModifiedStore'
import type { SyncMessageBroker } from './SyncMessageBroker'
import type { ClientEventHub } from './SyncEventHub'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { SnapshotTracker } from './SnapshotTracker'
import type { SnapshotBuilder } from './snapshotBuilder'
import { SnapshotPusher } from './SnapshotPusher'
import type { SnapshotPushResult } from './syncProtocol'
import { fireAndForget } from '../utils/fireAndForget'
import type { SyncSessionState } from './SyncSessionState'
import type { StoredSnapshotRecorder, UploadableSnapshot } from './snapshotUpload'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
}

/**
 * Wires the snapshot tracker and pusher together and reacts to the session's changes. Callers read and
 * mark dirty items through `tracker`.
 */
export class SnapshotManager implements StoredSnapshotRecorder {
  readonly tracker: SnapshotTracker
  private readonly pusher: SnapshotPusher
  private readonly session: SyncSessionState

  constructor(
    deps: {
      accountId: string
      session: SyncSessionState
      lastModifiedStore: LastModifiedStore
      builder: SnapshotBuilder
      broker: SyncMessageBroker
      getLatestCursor?: () => number
      eventHub: ClientEventHub
      recoveryManager: RecoveryManager
      apiClient: SyncApiClient
    },
    options?: SnapshotManagerOptions,
  ) {
    this.session = deps.session
    this.tracker = new SnapshotTracker({
      lastModifiedStore: deps.lastModifiedStore,
      recoveryManager: deps.recoveryManager,
      debounceDelayMs: options?.debounceDelayMs,
      maxWaitMs: options?.maxWaitMs,
      session: deps.session,
      onTriggerPush: () => fireAndForget(this.pusher.triggerSnapshotPush(), 'SnapshotManager:onTriggerPush'),
      isRetryActive: () => this.pusher.isRetryActive,
    })

    this.pusher = new SnapshotPusher({
      accountId: deps.accountId,
      session: deps.session,
      tracker: this.tracker,
      builder: deps.builder,
      broker: deps.broker,
      recoveryManager: deps.recoveryManager,
      apiClient: deps.apiClient,
      eventHub: deps.eventHub,
      getLatestCursor: deps.getLatestCursor,
      maxPayloadBytes: options?.maxPayloadBytes,
    })
  }

  /** Called after the session's leadership changed */
  async onLeaderChange(): Promise<void> {
    if (this.session.isShutdown) return
    this.tracker.onLeaderChange()

    if (this.session.isLeader) {
      await this.tracker.loadLastModified()
    } else {
      this.stopPushing()
    }
  }

  /** Called after the session's online state changed */
  onOnlineStateChange(): void {
    if (this.session.isOnline) {
      if (this.session.isLeader && this.tracker.dirtyCount > 0) {
        this.pusher.resetRetry()
        fireAndForget(this.pusher.triggerSnapshotPush(), 'SnapshotManager:onOnlineStateChange')
      }
    } else {
      this.stopPushing()
    }
  }

  /** Aborts any push in flight and cancels a pending retry */
  private stopPushing(): void {
    this.pusher.abortPush()
    this.pusher.cancelRetry()
  }

  async flushPendingSnapshots(): Promise<SnapshotPushResult> {
    // Saved first, and in any tab: a follower can't push, but its edits must still survive the page closing
    this.tracker.flushPendingSave()
    return this.pusher.flushPendingSnapshots()
  }

  recordStoredSnapshots(stored: UploadableSnapshot[], versions: Map<ItemId, number>): void {
    this.pusher.recordStoredSnapshots(stored, versions)
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.pusher.shutdown()
    await this.tracker.shutdown(options)
  }
}
