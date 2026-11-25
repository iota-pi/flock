import type { ItemId } from '@vault/shared'
import type { ClientEventHub } from './SyncEventHub'
import type { ItemSyncState } from './ItemSyncState'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { SnapshotSchedule } from './SnapshotSchedule'
import type { SnapshotBuilder } from './SnapshotBuilder'
import { SnapshotPusher, type SnapshotPushOutcome } from './SnapshotPusher'
import type { SnapshotPushResult } from './syncProtocol'
import type { SyncSessionState } from './SyncSessionState'
import type { StoredSnapshotDetails, StoredSnapshotRecorder, UploadableSnapshot } from './snapshotUpload'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
}

/**
 * Wires the snapshot schedule and pusher together. Uploads run as the last phase of each poll
 * (`pushDue`), so they share the poll's leadership, online state, abort, auth handling and backoff.
 * Callers read and mark dirty items through `schedule`, and read base versions through `state`.
 */
export class SnapshotManager implements StoredSnapshotRecorder {
  readonly schedule: SnapshotSchedule
  /** Each item's sync record, which the context owns and stops */
  readonly state: ItemSyncState
  private readonly pusher: SnapshotPusher
  private readonly loadGuard = new SingleFlightGuard<void>()
  private readonly session: SyncSessionState
  private readonly runPollNow: () => Promise<void>
  private readonly isCaughtUp: () => boolean
  private readonly hasPendingMarks: () => Promise<boolean>
  private lastPush: SnapshotPushResult = { persisted: 0, total: 0 }
  private pushes = 0

  constructor(
    deps: {
      accountId: string
      session: SyncSessionState
      state: ItemSyncState
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
      /**
       * Whether any item has a pending mark. A pushed mark's acknowledgement makes its item dirty in
       * the same poll, so a flush with nothing dirty yet still has something to upload.
       */
      hasPendingMarks: () => Promise<boolean>
    },
    options?: SnapshotManagerOptions,
  ) {
    this.session = deps.session
    this.runPollNow = deps.runPollNow
    this.isCaughtUp = deps.isCaughtUp
    this.hasPendingMarks = deps.hasPendingMarks
    this.state = deps.state
    this.schedule = new SnapshotSchedule({
      state: deps.state,
      recoveryManager: deps.recoveryManager,
      debounceDelayMs: options?.debounceDelayMs,
      maxWaitMs: options?.maxWaitMs,
      session: deps.session,
      onDueChanged: deps.onDueChanged,
    })

    this.pusher = new SnapshotPusher({
      accountId: deps.accountId,
      session: deps.session,
      schedule: this.schedule,
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
  onLeaderChange(): void {
    if (this.session.isShutdown) return
    this.schedule.onLeaderChange()
  }

  /**
   * Loads the item records and queues the items they flag, at start and when this tab becomes the
   * leader. Concurrent callers share one load.
   */
  async load(): Promise<void> {
    if (this.session.isShutdown) return
    await this.loadGuard.run(async () => {
      await this.state.load()
      await this.schedule.restoreFlagged()
    })
  }

  /** Each item's base version, and whether it's queued for a snapshot, for a manifest sync */
  exportItemVersions(): Map<ItemId, { baseVersion: number; isDirty: boolean }> {
    const result = new Map<ItemId, { baseVersion: number; isDirty: boolean }>()
    for (const [itemId, baseVersion] of this.state.listBaseVersions()) {
      result.set(itemId, { baseVersion, isDirty: this.schedule.isDirty(itemId) })
    }
    for (const itemId of this.schedule.getDirtyItemIds()) {
      if (!result.has(itemId)) result.set(itemId, { baseVersion: 0, isDirty: true })
    }
    return result
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
   * Uploads every dirty item's snapshot now, with a poll, such as when the page may be closing. Items
   * with pending marks go too: the poll pushes them to the log first, and their acknowledgement makes
   * them dirty, due in the same poll's snapshot phase. Never call it from inside a poll, which it
   * would wait for.
   */
  async flushPendingSnapshots(): Promise<SnapshotPushResult> {
    // Saved first, in case the page is closing
    this.state.flushPendingSave()
    if (!this.session.isOperational) return { persisted: 0, total: 0 }
    if (this.schedule.dirtyCount === 0 && !(await this.hasPendingMarks())) {
      return { persisted: 0, total: 0 }
    }
    this.schedule.requestNow()
    const pushesBefore = this.pushes
    await this.runPollNow()
    // Nothing became dirty, so the request mustn't make a later edit's snapshot due at once
    if (this.schedule.dirtyCount === 0) this.schedule.clearDue()
    return this.pushes > pushesBefore ? this.lastPush : { persisted: 0, total: 0 }
  }

  recordStoredSnapshots(stored: UploadableSnapshot[], versions: Map<ItemId, number>): void {
    this.pusher.recordStoredSnapshots(stored, versions)
  }

  /** Called once polling has stopped, so no upload is in flight. The item records save as `state` stops. */
  async shutdown(): Promise<void> {
    await this.loadGuard.waitForRunning()
    this.pusher.clear()
    this.schedule.clear()
    this.loadGuard.clear()
  }
}
