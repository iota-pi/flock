import type { ItemId } from '@vault/shared'
import type { LastModifiedStore } from './stores/LastModifiedStore'
import type { ClientEventHub } from './SyncEventHub'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { SnapshotTracker } from './SnapshotTracker'
import type { SnapshotBuilder } from './SnapshotBuilder'
import { SnapshotPusher, type SnapshotPushOutcome } from './SnapshotPusher'
import type { SnapshotPushResult } from './syncProtocol'
import type { SyncSessionState } from './SyncSessionState'
import type { StoredSnapshotRecorder, UploadableSnapshot } from './snapshotUpload'
import type { StoredSnapshotDetails } from './SnapshotCoverage'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
}

/**
 * Wires the snapshot tracker and pusher together. Uploads run as the last phase of each poll
 * (`pushDue`), so they share the poll's leadership, online state, abort, auth handling and backoff.
 * Callers read and mark dirty items through `tracker`.
 */
export class SnapshotManager implements StoredSnapshotRecorder {
  readonly tracker: SnapshotTracker
  private readonly pusher: SnapshotPusher
  private readonly session: SyncSessionState
  private readonly runPollNow: () => Promise<void>
  private lastPush: SnapshotPushResult = { persisted: 0, total: 0 }
  private pushes = 0
  /** The poll's phase and a manifest sync's upload never run at once */
  private readonly uploadGuard = new SingleFlightGuard<SnapshotPushOutcome>()

  constructor(
    deps: {
      accountId: string
      session: SyncSessionState
      lastModifiedStore: LastModifiedStore
      builder: SnapshotBuilder
      pushToLog: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
      onSnapshotStored: (details: StoredSnapshotDetails) => void
      getLatestCursor?: () => number
      eventHub: ClientEventHub
      recoveryManager: RecoveryManager
      apiClient: SyncApiClient
      /** Called when snapshots may be due sooner, so the next poll can be brought forward */
      onDueChanged?: () => void
      /** Runs a poll now, or right after the one in flight, resolving once it has finished */
      runPollNow: () => Promise<void>
    },
    options?: SnapshotManagerOptions,
  ) {
    this.session = deps.session
    this.runPollNow = deps.runPollNow
    this.tracker = new SnapshotTracker({
      lastModifiedStore: deps.lastModifiedStore,
      recoveryManager: deps.recoveryManager,
      debounceDelayMs: options?.debounceDelayMs,
      maxWaitMs: options?.maxWaitMs,
      session: deps.session,
      onDueChanged: deps.onDueChanged,
    })

    this.pusher = new SnapshotPusher({
      accountId: deps.accountId,
      session: deps.session,
      tracker: this.tracker,
      builder: deps.builder,
      pushToLog: deps.pushToLog,
      onSnapshotStored: deps.onSnapshotStored,
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
    }
  }

  /**
   * The poll's snapshot phase. Throws to fail the poll; see `SnapshotPusher.pushDue`. Joins an upload
   * already running for a manifest sync.
   */
  async pushDue(signal: AbortSignal): Promise<SnapshotPushOutcome> {
    const result = await this.uploadGuard.run(() => this.pusher.pushDue(signal))
    if (result.total > 0 || !result.success) {
      this.lastPush = { persisted: result.persisted, total: result.total }
      this.pushes += 1
    }
    return result
  }

  /**
   * Uploads every dirty item's snapshot now, without a poll, after any upload in flight. For a
   * manifest sync, which often runs inside a poll, so it can't wait for one. Throws if a request fails.
   */
  async uploadNow(signal: AbortSignal): Promise<SnapshotPushOutcome> {
    if (!this.session.isOperational || this.tracker.dirtyCount === 0) {
      return { persisted: 0, total: 0, success: true }
    }
    while (this.uploadGuard.isRunning) {
      await this.uploadGuard.waitForRunning()
    }
    this.tracker.requestNow()
    return this.pushDue(signal)
  }

  /**
   * Uploads every dirty item's snapshot now, with a poll, such as when the page may be closing. Never
   * call it from inside a poll, which it would wait for: use `uploadNow` there.
   */
  async flushPendingSnapshots(): Promise<SnapshotPushResult> {
    // Saved first, and in any tab: a follower can't push, but its edits must still survive the page closing
    this.tracker.flushPendingSave()
    if (!this.session.isOperational || this.tracker.dirtyCount === 0) {
      return { persisted: 0, total: 0 }
    }
    this.tracker.requestNow()
    const pushesBefore = this.pushes
    await this.runPollNow()
    return this.pushes > pushesBefore ? this.lastPush : { persisted: 0, total: 0 }
  }

  recordStoredSnapshots(stored: UploadableSnapshot[], versions: Map<ItemId, number>, logSeq: number): void {
    this.pusher.recordStoredSnapshots(stored, versions, logSeq)
  }

  /** Called once polling has stopped, so no upload is in flight */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.pusher.clear()
    await this.tracker.shutdown(options)
  }
}
