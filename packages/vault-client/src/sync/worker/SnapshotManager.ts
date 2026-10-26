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
import type { LifecycleAware } from './ServiceLifecycleManager'
import type { SnapshotPushResult } from './syncProtocol'
import { fireAndForget } from '../utils/fireAndForget'
import type { KeyProvider } from '../../api/Keyring'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
  isLeader?: boolean
}

export class SnapshotManager implements LifecycleAware<{ clearLocalData?: boolean }> {
  readonly lifecycleName = 'SnapshotManager'
  private readonly tracker: SnapshotTracker
  private readonly builder: SnapshotBuilder
  private readonly pusher: SnapshotPusher

  async onLifecycleStart(): Promise<void> {
    await this.loadLastModified()
  }

  async onLifecycleStop(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.shutdown(options)
  }

  constructor(
    deps: {
      accountId: string
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
    this.builder = new SnapshotBuilder(deps.repo, deps.keys, deps.codec)
    this.tracker = new SnapshotTracker({
      lastModifiedStore,
      recoveryManager: deps.recoveryManager,
      debounceDelayMs: options?.debounceDelayMs,
      maxWaitMs: options?.maxWaitMs,
      isLeader: options?.isLeader,
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

  get leader(): boolean {
    return this.tracker.leader
  }

  async setLeader(isLeader: boolean): Promise<void> {
    if (this.tracker.isShutdown || this.tracker.leader === isLeader) {
      return
    }
    this.tracker.setLeader(isLeader)

    if (isLeader) {
      await this.loadLastModified()
    } else {
      this.pusher.abortPush()
      this.pusher.cancelRetry()
    }
  }

  onOnlineStateChange(isOnline: boolean): void {
    this.tracker.setOnline(isOnline)
    if (isOnline) {
      if (this.tracker.leader && this.tracker.dirtyCount > 0) {
        this.pusher.resetRetry()
        fireAndForget(this.pusher.triggerSnapshotPush(), 'SnapshotManager:onOnlineStateChange')
      }
    } else {
      this.pusher.abortPush()
      this.pusher.cancelRetry()
    }
  }

  async loadLastModified(): Promise<void> {
    const oversizedItemIds = await this.tracker.loadLastModified()
    for (const id of oversizedItemIds) {
      this.pusher.addOversized(id)
    }
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
    this.pusher.clearOversized(itemId)
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

  clear(): void {
    this.tracker.clear()
    this.pusher.clear()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.pusher.shutdown()
    await this.tracker.shutdown(options)
  }
}
