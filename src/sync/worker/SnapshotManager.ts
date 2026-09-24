import type { Repo } from '@automerge/automerge-repo/slim'
import { ItemId } from 'src/shared/schemas/items'
import { LastModifiedStore } from './stores/LastModifiedStore'
import type { SyncMessageBroker } from './SyncMessageBroker'
import type { ClientEventHub } from './SyncEventHub'
import { RecoveryManager } from './RecoveryManager'
import { SyncApiClient } from './SyncApiClient'
import { SnapshotTracker } from './SnapshotTracker'
import { SnapshotBuilder } from './snapshotBuilder'
import { SnapshotPusher } from './SnapshotPusher'

export { SnapshotTracker, SnapshotBuilder, SnapshotPusher }

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
  isLeader?: boolean
}

export class SnapshotManager {
  private readonly tracker: SnapshotTracker
  private readonly builder: SnapshotBuilder
  private readonly pusher: SnapshotPusher

  constructor(
    deps: {
      accountId: string
      repo: Repo
      broker: SyncMessageBroker
      getLatestCursor?: () => number
      eventHub?: ClientEventHub
      recoveryManager?: RecoveryManager
      apiClient?: SyncApiClient
    },
    lastModifiedStore: LastModifiedStore,
    options?: SnapshotManagerOptions,
  ) {
    this.builder = new SnapshotBuilder(deps.repo)
    const recoveryManager = deps.recoveryManager ?? new RecoveryManager({
      accountId: deps.accountId,
      eventHub: deps.eventHub,
    })

    this.tracker = new SnapshotTracker({
      accountId: deps.accountId,
      lastModifiedStore,
      recoveryManager,
      debounceDelayMs: options?.debounceDelayMs,
      maxWaitMs: options?.maxWaitMs,
      isLeader: options?.isLeader,
      onTriggerPush: () => void this.pusher.triggerSnapshotPush(),
      isRetryActive: () => this.pusher.isRetryActive,
      onOversizedFound: itemId => this.pusher.addOversized(itemId),
    })

    this.pusher = new SnapshotPusher({
      accountId: deps.accountId,
      tracker: this.tracker,
      builder: this.builder,
      broker: deps.broker,
      recoveryManager,
      apiClient: deps.apiClient,
      eventHub: deps.eventHub,
      getLatestCursor: deps.getLatestCursor,
      maxPayloadBytes: options?.maxPayloadBytes,
    })
  }

  get isOperational(): boolean {
    return this.tracker.isOperational
  }

  get leader(): boolean {
    return this.tracker.leader
  }

  async setLeader(isLeader: boolean): Promise<void> {
    if (this.isShutdown || this.tracker.leader === isLeader) {
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
        void this.pusher.triggerSnapshotPush()
      }
    } else {
      this.pusher.abortPush()
      this.pusher.cancelRetry()
    }
  }

  async loadLastModified(): Promise<void> {
    const { oversizedItemIds } = await this.tracker.loadLastModified()
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

  recordInboundChange(itemId: ItemId, timestamp: number = Date.now()): void {
    this.tracker.recordInboundChange(itemId, timestamp)
  }

  getLastSnapshotAt(itemId: ItemId): number | undefined {
    return this.tracker.getLastSnapshotAt(itemId)
  }

  getLocalModifiedAt(itemId: ItemId): number | undefined {
    return this.tracker.getLocalModifiedAt(itemId)
  }

  scheduleDebouncedSnapshotPush(customDelayMs?: number): void {
    this.tracker.scheduleDebouncedSnapshotPush(customDelayMs)
  }

  async flushPendingSnapshots(): Promise<{ persisted: number; total: number }> {
    return this.pusher.flushPendingSnapshots()
  }

  async flushDirtyDocumentsToIndex(): Promise<void> {
    await this.tracker.flushDirtyDocumentsToIndex()
  }

  scheduleSnapshotPush(cursor?: number): void {
    this.pusher.scheduleSnapshotPush(cursor)
  }

  async triggerSnapshotPush(): Promise<{ persisted: number; total: number }> {
    return this.pusher.triggerSnapshotPush()
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    return this.pusher.pushSnapshots()
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

  clear(): void {
    this.tracker.clear()
    this.pusher.clear()
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    await this.pusher.shutdown()
    await this.tracker.shutdown(options)
  }

  // --- Test & Backward Compatibility Accessors ---
  get dirtyItems(): Map<ItemId, number> {
    return this.tracker.dirtyItems
  }

  get lastModifiedByItemId(): Map<ItemId, number> {
    return this.tracker.lastModifiedByItemId
  }

  get lastSnapshotAtByItemId(): Map<ItemId, number> {
    return this.tracker.lastSnapshotAtByItemId
  }

  get debounceTimer(): ReturnType<typeof setTimeout> | null {
    return this.tracker.debounceTimer
  }

  get maxWaitTimer(): ReturnType<typeof setTimeout> | null {
    return this.tracker.maxWaitTimer
  }

  get snapshotRequestCursor(): number | null {
    return this.pusher.snapshotRequestCursor
  }

  get retryAttempt(): number {
    return this.pusher.retryAttempt
  }

  set retryAttempt(val: number) {
    this.pusher.retryAttempt = val
  }

  get retryTimeoutId(): ReturnType<typeof setTimeout> | null {
    return this.pusher.retryTimeoutId
  }

  get snapshotPushPending(): boolean {
    return this.pusher.snapshotPushPending
  }

  get consecutiveFailures(): Map<ItemId, number> {
    return this.pusher.consecutiveFailures
  }

  get oversizedItems(): Set<ItemId> {
    return this.pusher.oversizedItems
  }

  get isLeader(): boolean {
    return this.tracker.leader
  }

  set isLeader(val: boolean) {
    this.tracker.setLeader(val)
  }

  get isOnline(): boolean {
    return this.tracker['isOnline']
  }

  get isShutdown(): boolean {
    return this.tracker['isShutdown']
  }

  get pushGuard() {
    return this.pusher.pushGuard
  }

  get loadGuard() {
    return this.tracker['loadGuard']
  }
}
