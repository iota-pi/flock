import type { Repo } from '@automerge/automerge-repo/slim'
import { ItemId } from '@vault/shared'
import { LastModifiedStore } from './stores/LastModifiedStore'
import type { SyncMessageBroker } from './SyncMessageBroker'
import type { ClientEventHub } from './SyncEventHub'
import type { RecoveryManager } from './RecoveryManager'
import type { SyncApiClient } from './SyncApiClient'
import { SnapshotTracker } from './SnapshotTracker'
import { SnapshotBuilder } from './snapshotBuilder'
import type { DocCodec } from './domain'
import { SnapshotPusher } from './SnapshotPusher'
import type { SnapshotPushResult } from './syncProtocol'
import { fireAndForget } from '../utils/fireAndForget'
import type { KeyProvider } from '../../api/Keyring'
import type { SyncSessionState } from './SyncSessionState'
import type { StoredSnapshotRecorder, UploadableSnapshot } from './snapshotUpload'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
}

export class SnapshotManager implements StoredSnapshotRecorder {
  private readonly tracker: SnapshotTracker
  private readonly builder: SnapshotBuilder
  private readonly pusher: SnapshotPusher
  private readonly session: SyncSessionState

  async loadLastModified(): Promise<void> {
    await this.tracker.loadLastModified()
  }

  constructor(
    deps: {
      accountId: string
      session: SyncSessionState
      repo: Repo
      broker: SyncMessageBroker
      getLatestCursor?: () => number
      eventHub: ClientEventHub
      recoveryManager: RecoveryManager
      apiClient: SyncApiClient
      codec: DocCodec
      keys: KeyProvider
    },
    lastModifiedStore: LastModifiedStore,
    options?: SnapshotManagerOptions,
  ) {
    this.session = deps.session
    this.builder = new SnapshotBuilder(deps.repo, deps.keys, deps.codec)
    this.tracker = new SnapshotTracker({
      lastModifiedStore,
      recoveryManager: deps.recoveryManager,
      debounceDelayMs: options?.debounceDelayMs,
      maxWaitMs: options?.maxWaitMs,
      session: deps.session,
      onTriggerPush: () => fireAndForget(this.pusher.triggerSnapshotPush(), 'SnapshotManager:onTriggerPush'),
      isRetryActive: () => this.pusher.isRetryActive,
    })

    this.pusher = new SnapshotPusher({
      accountId: deps.accountId,
      tracker: this.tracker,
      builder: this.builder,
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

  async persistLastModified(): Promise<void> {
    await this.tracker.persistLastModified()
  }

  markItemDirty(itemId: ItemId, customDebounceDelayMs?: number): void {
    this.tracker.markItemDirty(itemId, customDebounceDelayMs)
  }

  deleteDirtyItem(itemId: ItemId): boolean {
    return this.tracker.deleteDirtyItem(itemId)
  }

  async flushPendingSnapshots(): Promise<SnapshotPushResult> {
    // Saved first, and in any tab: a follower can't push, but its edits must still survive the page closing
    this.tracker.flushPendingSave()
    return this.pusher.flushPendingSnapshots()
  }

  clearOversized(itemId: ItemId): void {
    this.tracker.clearOversized(itemId)
  }

  getDirtyItemIds(): ItemId[] {
    return this.tracker.getDirtyItemIds()
  }

  exportLastModified(): [ItemId, number][] {
    return this.tracker.exportLastModified()
  }

  async importLastModified(data: [ItemId, number][]): Promise<void> {
    await this.tracker.importLastModified(data)
  }

  exportItemVersions(): Map<ItemId, { baseVersion: number; isDirty: boolean }> {
    return this.tracker.exportItemVersions()
  }

  async importVersions(updates: Array<[ItemId, number]>): Promise<void> {
    await this.tracker.importVersions(updates)
  }

  recordStoredSnapshots(stored: UploadableSnapshot[], versions: Map<ItemId, number>): void {
    this.pusher.recordStoredSnapshots(stored, versions)
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.pusher.shutdown()
    await this.tracker.shutdown(options)
  }
}
