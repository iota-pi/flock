import type { ItemId } from '@vault/shared'
import type { SyncLogDatabase } from './stores/SyncLogDatabase'
import type { ClientEventHub } from './SyncEventHub'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { SnapshotTracker } from './SnapshotTracker'
import type { SnapshotBuilder } from './SnapshotBuilder'
import { SnapshotPusher, type SnapshotPushOutcome } from './SnapshotPusher'
import type { SnapshotPushResult } from './syncProtocol'
import type { SyncSessionState } from './SyncSessionState'
import type { StoredSnapshotDetails, StoredSnapshotRecorder, UploadableSnapshot } from './snapshotUpload'

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
  private readonly isCaughtUp: () => boolean
  private lastPush: SnapshotPushResult = { persisted: 0, total: 0 }
  private pushes = 0

  constructor(
    deps: {
      accountId: string
      session: SyncSessionState
      db: Pick<SyncLogDatabase, 'getAll' | 'update'>
      builder: SnapshotBuilder
      pushToLog: (itemIds: ItemId[], signal?: AbortSignal) => Promise<void>
      onSnapshotStored: (details: StoredSnapshotDetails) => void
      eventHub: ClientEventHub
      recoveryManager: RecoveryManager
      apiClient: SyncApiClient
      /** Called when snapshots may be due sooner, so the next poll can be brought forward */
      onDueChanged?: () => void
      /** Runs a poll now, or right after the one in flight, resolving once it has finished */
      runPollNow: () => Promise<void>
      /**
       * Whether the device has caught up (`SyncLogPuller.isCaughtUp`). Until then nothing is uploaded,
       * since a snapshot could replace one holding what the doc hasn't merged yet.
       */
      isCaughtUp: () => boolean
    },
    options?: SnapshotManagerOptions,
  ) {
    this.session = deps.session
    this.runPollNow = deps.runPollNow
    this.isCaughtUp = deps.isCaughtUp
    this.tracker = new SnapshotTracker({
      db: deps.db,
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
      maxPayloadBytes: options?.maxPayloadBytes,
    })
  }

  /** Called after the session's leadership changed */
  async onLeaderChange(): Promise<void> {
    if (this.session.isShutdown) return
    this.tracker.onLeaderChange()

    if (this.session.isLeader) {
      await this.tracker.load()
    }
  }

  /**
   * The poll's snapshot phase, and the manifest phase's upload before it fetches the manifest. Both
   * run inside the poll, so never at once. Throws to fail the poll; see `SnapshotPusher.pushDue`.
   *
   * Uploads nothing until the device has caught up, leaving what's due for the snapshot phase of the
   * poll that does. Catch-up's own manifest sync would otherwise upload before it has merged the
   * server's snapshots: a device away longer than the log's TTL, or one that has just reset its
   * sync state, can hold a doc that lacks what only the server's snapshot holds.
   */
  async pushDue(signal: AbortSignal): Promise<SnapshotPushOutcome> {
    if (!this.isCaughtUp()) return { persisted: 0, total: 0, success: true }
    const result = await this.pusher.pushDue(signal)
    if (result.total > 0 || !result.success) {
      this.lastPush = { persisted: result.persisted, total: result.total }
      this.pushes += 1
    }
    return result
  }

  /**
   * Uploads every dirty item's snapshot now, with a poll, such as when the page may be closing. Never
   * call it from inside a poll, which it would wait for.
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

  recordStoredSnapshots(stored: UploadableSnapshot[], versions: Map<ItemId, number>): void {
    this.pusher.recordStoredSnapshots(stored, versions)
  }

  /** Called once polling has stopped, so no upload is in flight */
  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    this.pusher.clear()
    await this.tracker.shutdown(options)
  }
}
