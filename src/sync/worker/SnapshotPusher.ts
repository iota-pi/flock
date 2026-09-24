import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { SyncApiClient } from './SyncApiClient'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { classifySyncError } from './utils/errorClassifier'
import { ItemId } from 'src/shared/schemas/items'
import type { ClientEventHub } from './SyncEventHub'
import { RecoveryManager } from './RecoveryManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { checkAlive, isAbortError } from './utils/abort'
import { SizeAwareBatchAccumulator } from '../utils/SizeAwareBatchAccumulator'
import type { PreparedSnapshotItem } from './SnapshotBatchAccumulator'
import { SnapshotTracker } from './SnapshotTracker'
import { SnapshotBuilder } from './snapshotBuilder'

export interface SnapshotPusherOptions {
  accountId: string
  tracker: SnapshotTracker
  builder: SnapshotBuilder
  broker: SyncMessageBroker
  recoveryManager?: RecoveryManager
  apiClient?: SyncApiClient
  eventHub?: ClientEventHub
  getLatestCursor?: () => number
  maxPayloadBytes?: number
}

export interface SnapshotPushResult {
  persisted: number
  total: number
  success: boolean
}

type ItemPreparationResult =
  | { type: 'ready'; item: PreparedSnapshotItem; size: number }
  | { type: 'not-ready' }
  | { type: 'error' }
  | { type: 'oversized' }
  | { type: 'skipped' }

const MAX_CONSECUTIVE_SNAPSHOT_FAILURES = 5

export class SnapshotPusher {
  private readonly accountId: string
  private readonly tracker: SnapshotTracker
  private readonly builder: SnapshotBuilder
  private readonly broker: SyncMessageBroker
  private readonly recoveryManager: RecoveryManager
  private readonly apiClient: SyncApiClient
  private readonly eventHub?: ClientEventHub
  private readonly getLatestCursor?: () => number
  public readonly maxPayloadBytes: number

  public readonly consecutiveFailures = new Map<ItemId, number>()
  public readonly oversizedItems = new Set<ItemId>()
  public readonly pushGuard = new SingleFlightGuard<SnapshotPushResult>()
  public pushAbortController: AbortController | null = null
  public snapshotPushPending = false
  public snapshotRequestCursor: number | null = null
  public retryTimeoutId: ReturnType<typeof setTimeout> | null = null
  public readonly retryStrategy = new RetryStrategy({ delays: DEFAULT_RETRY_DELAYS })

  constructor(options: SnapshotPusherOptions) {
    this.accountId = options.accountId
    this.tracker = options.tracker
    this.builder = options.builder
    this.broker = options.broker
    this.eventHub = options.eventHub
    this.getLatestCursor = options.getLatestCursor
    this.maxPayloadBytes = options.maxPayloadBytes ?? 350 * 1024
    this.apiClient = options.apiClient ?? new SyncApiClient()
    this.recoveryManager = options.recoveryManager ?? new RecoveryManager({
      accountId: options.accountId,
      eventHub: options.eventHub,
    })
  }

  get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  set retryAttempt(val: number) {
    this.retryStrategy.attempt = val
  }

  get retryDelays(): readonly number[] {
    return this.retryStrategy.delays
  }

  get isRetryActive(): boolean {
    return this.retryTimeoutId !== null
  }

  abortPush(): void {
    if (this.pushAbortController) {
      this.pushAbortController.abort()
      this.pushAbortController = null
    }
  }

  cancelRetry(): void {
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
  }

  resetRetry(): void {
    this.retryAttempt = 0
    this.cancelRetry()
  }

  scheduleSnapshotPush(cursor?: number): void {
    if (!this.tracker.isOperational) return
    if (typeof cursor === 'number') {
      this.snapshotRequestCursor = cursor
    }
    void this.triggerSnapshotPush()
  }

  async triggerSnapshotPush(): Promise<{ persisted: number; total: number }> {
    if (!this.tracker.isOperational) {
      return { persisted: 0, total: 0 }
    }
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
    if (this.pushGuard.isRunning) {
      this.snapshotPushPending = true
      const res = await this.pushGuard.waitForRunning()
      return { persisted: res?.persisted ?? 0, total: res?.total ?? 0 }
    }

    return this.pushSnapshots()
  }

  scheduleRetry(): void {
    if (!this.tracker.isOperational || this.retryTimeoutId !== null) {
      return
    }

    this.tracker.clearDebounceTimers()

    const delayMs = this.retryStrategy.nextDelay()

    console.warn(`[SnapshotPusher] Scheduling snapshot push retry (attempt ${this.retryAttempt}) in ${delayMs}ms`)

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null
      if (this.tracker.dirtyCount > 0) {
        void this.pushSnapshots()
      }
    }, delayMs)
  }

  private async preparePushContext(): Promise<{
    accountId: string
    dirtyItemIds: ItemId[]
    snapshotCursor: number
  } | null> {
    if (!this.tracker.isOperational) {
      return null
    }
    const dirtyItemIds = this.tracker.getDirtyItemIds()
    if (dirtyItemIds.length === 0) {
      this.snapshotRequestCursor = null
      return null
    }

    const hasToken = await this.apiClient.hasAuthToken()
    if (!hasToken) {
      console.warn('[SnapshotPusher] Cannot push snapshots: missing active session token')
      return null
    }

    const snapshotCursor = this.snapshotRequestCursor ?? (this.getLatestCursor ? this.getLatestCursor() : 0)

    return {
      accountId: this.accountId,
      dirtyItemIds,
      snapshotCursor,
    }
  }

  private async sendSnapshotBatch(
    accountId: string,
    batch: VaultSnapshotInput[],
    signal?: AbortSignal,
  ): Promise<{ success: boolean; persisted: number }> {
    if (batch.length === 0) {
      return { success: true, persisted: 0 }
    }
    try {
      const response = await this.apiClient.putSnapshots(
        {
          account: accountId,
          snapshots: batch,
        },
        signal ? { signal } : undefined,
      )

      if (response?.success && response.persisted === batch.length) {
        return { success: true, persisted: response.persisted }
      }
      return { success: false, persisted: response?.persisted ?? 0 }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) {
        throw error
      }
      console.error('[SnapshotPusher] Failed to put snapshots', error)
      return { success: false, persisted: 0 }
    }
  }

  async handleSnapshotFailure(
    itemId: ItemId,
    tick: number,
    failureType: string,
    reason?: string,
  ): Promise<void> {
    const failures = (this.consecutiveFailures.get(itemId) ?? 0) + 1
    if (failures >= MAX_CONSECUTIVE_SNAPSHOT_FAILURES) {
      const detailedReason =
        reason ||
        `Snapshot ${failureType} failed after ${MAX_CONSECUTIVE_SNAPSHOT_FAILURES} consecutive attempts`
      console.error(
        `[SnapshotPusher] Item ${itemId} reached max consecutive snapshot ${failureType} failures (${MAX_CONSECUTIVE_SNAPSHOT_FAILURES}). Reason: ${detailedReason}. Moving to manual recovery.`,
      )
      this.consecutiveFailures.delete(itemId)
      this.tracker.removeDirtyItemIfTickMatches(itemId, tick)

      this.eventHub?.emit({
        type: 'snapshotFailed',
        itemId,
        message: `Snapshot sync failed for item ${itemId}: ${detailedReason}. Changes are stored locally only.`,
      })

      if (this.accountId) {
        try {
          await this.recoveryManager.quarantine(
            this.accountId,
            itemId,
            `Snapshot failure: ${detailedReason}`,
          )
        } catch (recoveryError) {
          console.error('[SnapshotPusher] Failed to record manual recovery entry', recoveryError)
        }
      }
    } else {
      this.consecutiveFailures.set(itemId, failures)
    }
  }

  handleOversizedItem(
    itemId: ItemId,
    snapshotSize: number,
    modified: number,
    accountId: string,
  ): void {
    const isAlreadyOversized = this.oversizedItems.has(itemId)
    this.oversizedItems.add(itemId)

    this.tracker.recordOversized(itemId, modified)

    if (!isAlreadyOversized) {
      console.error(
        `[SnapshotPusher] Snapshot for item ${itemId} exceeds maxPayloadBytes (${snapshotSize} > ${this.maxPayloadBytes}). Skipping.`,
      )
      this.eventHub?.emit({
        type: 'quotaExceeded',
        message: `Snapshot for item ${itemId} (${Math.round(snapshotSize / 1024)} KB) exceeds the 350 KB limit. History compaction is required to resume sync.`,
      })
      void this.recoveryManager
        .quarantine(
          accountId,
          itemId,
          `Snapshot size (${Math.round(snapshotSize / 1024)} KB) exceeds 350 KB limit. History compaction is required to resume sync.`,
        )
        .catch(() => {})
    }
  }

  private async prepareItemForPush(
    itemId: ItemId,
    snapshotCursor: number,
    accountId: string,
  ): Promise<ItemPreparationResult> {
    const tick = this.tracker.getDirtyTick(itemId)
    if (tick === undefined) {
      return { type: 'skipped' }
    }

    const buildResult = await this.builder.build(itemId, snapshotCursor)
    if (buildResult.type === 'not-ready') {
      return { type: 'not-ready' }
    }

    if (buildResult.type === 'error') {
      await this.handleSnapshotFailure(itemId, tick, 'build', buildResult.reason)
      return { type: 'error' }
    }

    const snapshot = buildResult.snapshot
    this.consecutiveFailures.delete(itemId)

    const snapshotSize = this.builder.estimateSize(snapshot)

    if (snapshotSize > this.maxPayloadBytes) {
      this.handleOversizedItem(itemId, snapshotSize, snapshot.modified, accountId)
      return { type: 'oversized' }
    }

    this.oversizedItems.delete(itemId)

    return {
      type: 'ready',
      item: { snapshot, tick, heads: buildResult.heads },
      size: snapshotSize,
    }
  }

  private finalizeSuccessfulBatch(
    batch: PreparedSnapshotItem[],
    accountId: string,
  ): void {
    for (const item of batch) {
      this.tracker.recordSnapshotSuccess(item.snapshot.itemId, item.snapshot.modified, item.tick)
      if (item.heads && item.heads.length > 0) {
        this.broker.setSyncedHeads?.(item.snapshot.itemId, item.heads)
      }
      this.broker.clearSnapshotOnlyItem?.(item.snapshot.itemId)
      this.broker.unblockItem?.(item.snapshot.itemId)
      void this.recoveryManager.unquarantine(accountId, item.snapshot.itemId).catch(() => {})
    }
  }

  private async flushBatch(
    batch: PreparedSnapshotItem[],
    accountId: string,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; persisted: number }> {
    if (batch.length === 0) {
      return { success: true, persisted: 0 }
    }
    const result = await this.sendSnapshotBatch(
      accountId,
      batch.map(b => b.snapshot),
      signal,
    )
    if (result.success) {
      this.finalizeSuccessfulBatch(batch, accountId)
    }
    return result
  }

  private async processSnapshotPush(
    context: {
      accountId: string
      dirtyItemIds: ItemId[]
      snapshotCursor: number
    },
    signal?: AbortSignal,
  ): Promise<{ persisted: number; total: number; success: boolean }> {
    const { accountId, dirtyItemIds, snapshotCursor } = context
    let persisted = 0
    let total = 0
    let success = true
    let sendFailed = false

    const accumulator = new SizeAwareBatchAccumulator<PreparedSnapshotItem>({
      maxBatchCount: 25,
      maxBatchBytes: this.maxPayloadBytes,
      calculateSize: item => this.builder.estimateSize(item.snapshot),
    })

    for (const itemId of dirtyItemIds) {
      checkAlive(signal, () => this.tracker.isOperational)
      const prepared = await this.prepareItemForPush(itemId, snapshotCursor, accountId)
      if (prepared.type === 'skipped') {
        continue
      }
      if (prepared.type === 'not-ready' || prepared.type === 'error') {
        success = false
        continue
      }
      if (prepared.type === 'oversized') {
        continue
      }

      if (accumulator.wouldExceed(prepared.size) && !accumulator.isEmpty) {
        const batch = accumulator.drain()
        total += batch.length
        checkAlive(signal, () => this.tracker.isOperational)
        const result = await this.flushBatch(batch, accountId, signal)
        persisted += result.persisted
        if (!result.success) {
          success = false
          sendFailed = true
          break
        }
      }

      accumulator.push(prepared.item, prepared.size)
    }

    // Flush any remaining items in the accumulator
    if (!sendFailed && !accumulator.isEmpty) {
      const batch = accumulator.drain()
      total += batch.length
      checkAlive(signal, () => this.tracker.isOperational)
      const result = await this.flushBatch(batch, accountId, signal)
      persisted += result.persisted
      if (!result.success) {
        success = false
      }
    }

    return { persisted, total, success }
  }

  private startPush(): Promise<SnapshotPushResult> {
    if (!this.tracker.isOperational) {
      return Promise.resolve({ persisted: 0, total: 0, success: true })
    }

    if (this.retryTimeoutId !== null && !this.pushGuard.isRunning) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }

    return this.pushGuard.run(() => this.executePush(), {
      onCoalesce: () => {
        this.snapshotPushPending = true
      },
    })
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    if (!this.tracker.isOperational) {
      return { persisted: 0, total: 0 }
    }
    const res = await this.startPush()
    return { persisted: res.persisted, total: res.total }
  }

  private async executePush(): Promise<SnapshotPushResult> {
    const abortController = new AbortController()
    this.pushAbortController = abortController
    const { signal } = abortController

    let persisted = 0
    let total = 0
    let success = true

    try {
      checkAlive(signal, () => this.tracker.isOperational)
      const context = await this.preparePushContext()
      if (!context) {
        if (this.tracker.dirtyCount > 0) {
          success = false
        }
        return { persisted: 0, total: 0, success }
      }

      checkAlive(signal, () => this.tracker.isOperational)
      const result = await this.processSnapshotPush(context, signal)
      persisted = result.persisted
      total = result.total
      success = result.success

      if (success) {
        this.snapshotRequestCursor = null
      }

      if (success && this.tracker.dirtyCount === 0) {
        this.retryAttempt = 0
      }

      return { persisted, total, success }
    } catch (error) {
      const classified = classifySyncError(error)
      if (signal.aborted || classified.isAbort || !this.tracker.isOperational) {
        return { persisted, total, success: false }
      }
      console.error('[SnapshotPusher] Error during pushSnapshots', error)
      success = false
      return { persisted, total, success }
    } finally {
      if (this.pushAbortController === abortController) {
        this.pushAbortController = null
      }
      this.handlePostPushScheduling(success)
    }
  }

  private handlePostPushScheduling(success: boolean): void {
    const hasDirtyDocs = this.tracker.dirtyCount > 0

    if (!success && hasDirtyDocs && this.tracker.isOperational) {
      this.scheduleRetry()
    } else if (this.snapshotPushPending && hasDirtyDocs && this.tracker.isOperational) {
      void this.triggerSnapshotPush()
    }

    this.snapshotPushPending = false
  }

  async flushPendingSnapshots(): Promise<{ persisted: number; total: number }> {
    this.tracker.clearDebounceTimers()
    if (!this.tracker.isOperational) {
      return { persisted: 0, total: 0 }
    }
    if (this.tracker.dirtyCount === 0 && !this.pushGuard.isRunning) {
      return { persisted: 0, total: 0 }
    }

    let persisted = 0
    let total = 0

    while (this.pushGuard.isRunning || this.tracker.dirtyCount > 0) {
      if (this.pushGuard.isRunning) {
        const result = await this.pushGuard.waitForRunning()
        if (result) {
          persisted += result.persisted
          total += result.total
          if (!result.success || (result.persisted === 0 && this.tracker.dirtyCount > 0)) {
            break
          }
        } else {
          break
        }
      } else {
        const result = await this.startPush()
        persisted += result.persisted
        total += result.total
        if (!result.success || (result.persisted === 0 && this.tracker.dirtyCount > 0)) {
          break
        }
      }
    }

    return { persisted, total }
  }

  clear(): void {
    this.cancelRetry()
    this.consecutiveFailures.clear()
    this.oversizedItems.clear()
    this.snapshotPushPending = false
    this.snapshotRequestCursor = null
    this.pushGuard.clear()
    this.retryAttempt = 0
  }

  clearOversized(itemId: ItemId): void {
    this.oversizedItems.delete(itemId)
  }

  addOversized(itemId: ItemId): void {
    this.oversizedItems.add(itemId)
  }

  async shutdown(): Promise<void> {
    this.abortPush()
    await this.pushGuard.waitForRunning()
    this.cancelRetry()
    this.clear()
  }
}
