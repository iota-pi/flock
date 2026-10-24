import type { VaultSnapshotInput } from '@vault/shared'
import type { SnapshotPushResult } from './syncProtocol'
import { SyncApiClient } from './SyncApiClient'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { classifySyncError } from './utils/errorClassifier'
import { ItemId, MAX_ITEM_SIZE_BYTES, MAX_ITEM_SIZE_KB } from '@vault/shared'
import type { ClientEventHub } from './SyncEventHub'
import { RecoveryManager } from './RecoveryManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { checkAlive, isAbortError } from '../utils/abort'
import { SizeAwareBatchAccumulator } from '../utils/SizeAwareBatchAccumulator'
import type { PreparedSnapshotItem } from './SnapshotBatchAccumulator'
import { SnapshotTracker } from './SnapshotTracker'
import { SnapshotBuilder, toTombstoneSnapshot } from './snapshotBuilder'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SnapshotPusher')

export interface SnapshotPusherOptions {
  accountId: string
  tracker: SnapshotTracker
  builder: SnapshotBuilder
  broker: SyncMessageBroker
  recoveryManager?: RecoveryManager
  apiClient: SyncApiClient
  eventHub?: ClientEventHub
  getLatestCursor?: () => number
  maxPayloadBytes?: number
}

/** A push's result, and whether every batch in it was sent and accepted */
interface SnapshotPushOutcome extends SnapshotPushResult {
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
  private readonly pushGuard = new SingleFlightGuard<SnapshotPushOutcome>()
  private pushAbortController: AbortController | null = null
  private pendingPushRequested = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  public readonly retryStrategy = new RetryStrategy({ delays: DEFAULT_RETRY_DELAYS })

  constructor(options: SnapshotPusherOptions) {
    this.accountId = options.accountId
    this.tracker = options.tracker
    this.builder = options.builder
    this.broker = options.broker
    this.eventHub = options.eventHub
    this.getLatestCursor = options.getLatestCursor
    this.maxPayloadBytes = options.maxPayloadBytes ?? MAX_ITEM_SIZE_BYTES
    this.apiClient = options.apiClient
    this.recoveryManager = options.recoveryManager ?? new RecoveryManager({
      accountId: options.accountId,
      eventHub: options.eventHub,
    })
  }

  get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  get isRetryActive(): boolean {
    return this.retryTimer !== null
  }

  /** Whether a push was asked for while one was running, so another follows it */
  get snapshotPushPending(): boolean {
    return this.pendingPushRequested
  }

  get retryTimeoutId(): ReturnType<typeof setTimeout> | null {
    return this.retryTimer
  }

  abortPush(): void {
    if (this.pushAbortController) {
      this.pushAbortController.abort()
      this.pushAbortController = null
    }
  }

  cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  resetRetry(): void {
    this.retryStrategy.reset()
    this.cancelRetry()
  }

  async triggerSnapshotPush(): Promise<SnapshotPushResult> {
    if (!this.tracker.isOperational) {
      return { persisted: 0, total: 0 }
    }
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.pushGuard.isRunning) {
      this.pendingPushRequested = true
      const res = await this.pushGuard.waitForRunning()
      return { persisted: res?.persisted ?? 0, total: res?.total ?? 0 }
    }

    return this.pushSnapshots()
  }

  scheduleRetry(): void {
    if (!this.tracker.isOperational || this.retryTimer !== null) {
      return
    }

    this.tracker.clearDebounceTimers()

    const delayMs = this.retryStrategy.nextDelay()

    log.warn(`Scheduling snapshot push retry (attempt ${this.retryAttempt}) in ${delayMs}ms`)

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.tracker.dirtyCount > 0) {
        fireAndForget(this.pushSnapshots(), 'SnapshotPusher:scheduleRetry')
      }
    }, delayMs)
  }

  private preparePushContext(): {
    dirtyItemIds: ItemId[]
    snapshotCursor: number
  } | null {
    if (!this.tracker.isOperational) {
      return null
    }
    const dirtyItemIds = this.tracker.getDirtyItemIds()
    if (dirtyItemIds.length === 0) {
      return null
    }

    const snapshotCursor = this.getLatestCursor ? this.getLatestCursor() : 0

    return {
      dirtyItemIds,
      snapshotCursor,
    }
  }

  /**
   * `responded` says whether the server answered. The server stores each snapshot on its own, so a
   * response can confirm some items and not others: `results` lists the stored ones.
   */
  private async sendSnapshotBatch(
    batch: VaultSnapshotInput[],
    signal?: AbortSignal,
  ): Promise<{
    success: boolean
    responded: boolean
    persisted: number
    results?: Array<{ itemId: ItemId; version: number }>
  }> {
    if (batch.length === 0) {
      return { success: true, responded: true, persisted: 0 }
    }
    try {
      const response = await this.apiClient.putSnapshots(
        {
          account: this.accountId,
          snapshots: batch,
        },
        signal ? { signal } : undefined,
      )

      return {
        success: Boolean(response?.success) && response.persisted === batch.length,
        responded: Boolean(response),
        persisted: response?.persisted ?? 0,
        results: response?.results,
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error) || classifySyncError(error).isAuth) {
        throw error
      }
      log.error('Failed to put snapshots', error)
      return { success: false, responded: false, persisted: 0 }
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
      log.error(
        `Item ${itemId} reached max consecutive snapshot ${failureType} failures (${MAX_CONSECUTIVE_SNAPSHOT_FAILURES}). Reason: ${detailedReason}. Moving to manual recovery.`,
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
            itemId,
            'snapshotFailure',
            `Snapshot failure: ${detailedReason}`,
          )
        } catch (recoveryError) {
          log.error('Failed to record manual recovery entry', recoveryError)
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
  ): void {
    const isAlreadyOversized = this.oversizedItems.has(itemId)
    this.oversizedItems.add(itemId)

    this.tracker.recordOversized(itemId, modified)

    if (!isAlreadyOversized) {
      log.error(
        `Snapshot for item ${itemId} exceeds maxPayloadBytes (${snapshotSize} > ${this.maxPayloadBytes}). Skipping.`,
      )
      this.eventHub?.emit({
        type: 'quotaExceeded',
        message: `Snapshot for item ${itemId} (${Math.round(snapshotSize / 1024)} KB) exceeds the ${MAX_ITEM_SIZE_KB} KB limit. Recreating the item with fresh history is required to resume sync.`,
      })
      fireAndForget(
        this.recoveryManager.quarantine(
          itemId,
          'oversized',
          `Snapshot size (${Math.round(snapshotSize / 1024)} KB) exceeds ${MAX_ITEM_SIZE_KB} KB limit. Recreating the item with fresh history is required to resume sync.`,
        ),
        'SnapshotPusher:quarantine',
      )
    }
  }

  private async prepareItemForPush(
    itemId: ItemId,
    snapshotCursor: number,
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

    // Failures are counted until an upload is confirmed (see finalizeSuccessfulBatch)
    const snapshot = buildResult.snapshot

    const snapshotSize = this.builder.estimateSize(snapshot)

    if (snapshotSize > this.maxPayloadBytes && snapshot.deleted === true) {
      // The full history can never be uploaded, but the server still needs to learn of the deletion
      this.oversizedItems.delete(itemId)
      log.warn(`Uploading metadata-only tombstone for oversized deleted item ${itemId}`)
      const tombstone = toTombstoneSnapshot(snapshot)
      return {
        type: 'ready',
        item: { snapshot: tombstone, tick, heads: undefined },
        size: this.builder.estimateSize(tombstone),
      }
    }

    if (snapshotSize > this.maxPayloadBytes) {
      this.handleOversizedItem(itemId, snapshotSize, snapshot.modified)
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
    versionsMap?: Map<ItemId, number>,
  ): void {
    for (const item of batch) {
      this.consecutiveFailures.delete(item.snapshot.itemId)
      const assignedVersion = versionsMap?.get(item.snapshot.itemId)
      this.tracker.recordSnapshotSuccess(item.snapshot.itemId, item.snapshot.modified, item.tick, assignedVersion)
      // Tombstones deliberately carry no heads: the server does not hold the document state
      if (item.heads && item.heads.length > 0) {
        this.broker.setSyncedHeads(item.snapshot.itemId, item.heads)
      }
      this.broker.clearSnapshotOnlyItem(item.snapshot.itemId)
      this.broker.unblockItem(item.snapshot.itemId)
      fireAndForget(
        this.recoveryManager.unquarantine(item.snapshot.itemId),
        'SnapshotPusher:unquarantine',
      )
    }
  }

  private async flushBatch(
    batch: PreparedSnapshotItem[],
    signal?: AbortSignal,
  ): Promise<{ success: boolean; responded: boolean; persisted: number }> {
    if (batch.length === 0) {
      return { success: true, responded: true, persisted: 0 }
    }
    const result = await this.sendSnapshotBatch(
      batch.map(b => b.snapshot),
      signal,
    )
    if (!result.responded) {
      return result
    }

    const versionsMap = result.results
      ? new Map(result.results.map(r => [r.itemId, r.version]))
      : undefined
    // Without per-item results, only a fully persisted batch says which items were stored
    const stored = versionsMap
      ? batch.filter(item => versionsMap.has(item.snapshot.itemId))
      : result.success ? batch : []
    this.finalizeSuccessfulBatch(stored, versionsMap)

    // An item the server's results leave out was rejected. It counts towards quarantine, so an item
    // the server keeps rejecting doesn't keep failing every push.
    if (versionsMap) {
      for (const item of batch) {
        if (!versionsMap.has(item.snapshot.itemId)) {
          await this.handleSnapshotFailure(item.snapshot.itemId, item.tick, 'upload')
        }
      }
    }
    return result
  }

  private async processSnapshotPush(
    context: {
      dirtyItemIds: ItemId[]
      snapshotCursor: number
    },
    signal?: AbortSignal,
  ): Promise<SnapshotPushOutcome> {
    const { dirtyItemIds, snapshotCursor } = context
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
      const prepared = await this.prepareItemForPush(itemId, snapshotCursor)
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
        const result = await this.flushBatch(batch, signal)
        persisted += result.persisted
        if (!result.success) {
          success = false
        }
        // A batch the server answered can fail for its own items only; later batches still go
        if (!result.responded) {
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
      const result = await this.flushBatch(batch, signal)
      persisted += result.persisted
      if (!result.success) {
        success = false
      }
    }

    return { persisted, total, success }
  }

  private startPush(): Promise<SnapshotPushOutcome> {
    if (!this.tracker.isOperational) {
      return Promise.resolve({ persisted: 0, total: 0, success: true })
    }

    if (this.retryTimer !== null && !this.pushGuard.isRunning) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }

    return this.runPush()
  }

  private async runPush(): Promise<SnapshotPushOutcome> {
    // Only set when this call ran the push rather than coalescing onto one
    let settledSuccess: boolean | null = null
    const result = await this.pushGuard.run(
      () => this.executePush(success => {
        settledSuccess = success
      }),
      {
        onCoalesce: () => {
          this.pendingPushRequested = true
        },
      },
    )
    // Scheduled once the guard has cleared, or a follow-up push would coalesce onto the finishing one
    if (settledSuccess !== null) {
      this.handlePostPushScheduling(settledSuccess)
    }
    return result
  }

  async pushSnapshots(): Promise<SnapshotPushResult> {
    if (!this.tracker.isOperational) {
      return { persisted: 0, total: 0 }
    }
    const res = await this.startPush()
    return { persisted: res.persisted, total: res.total }
  }

  private async executePush(onSettled: (success: boolean) => void): Promise<SnapshotPushOutcome> {
    const abortController = new AbortController()
    this.pushAbortController = abortController
    const { signal } = abortController

    let persisted = 0
    let total = 0
    let success = true

    try {
      checkAlive(signal, () => this.tracker.isOperational)
      const context = this.preparePushContext()
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

      if (success && this.tracker.dirtyCount === 0) {
        this.retryStrategy.reset()
      }

      return { persisted, total, success }
    } catch (error) {
      const classified = classifySyncError(error)
      if (signal.aborted || classified.isAbort || !this.tracker.isOperational) {
        return { persisted, total, success: false }
      }
      if (classified.isAuth) {
        log.warn('Cannot push snapshots: auth failure', error)
        success = false
        return { persisted, total, success }
      }
      log.error('Error during pushSnapshots', error)
      success = false
      return { persisted, total, success }
    } finally {
      if (this.pushAbortController === abortController) {
        this.pushAbortController = null
      }
      onSettled(success)
    }
  }

  private handlePostPushScheduling(success: boolean): void {
    const hasDirtyDocs = this.tracker.dirtyCount > 0
    const wasPending = this.pendingPushRequested
    this.pendingPushRequested = false

    if (!success && hasDirtyDocs && this.tracker.isOperational) {
      this.scheduleRetry()
    } else if (wasPending && hasDirtyDocs && this.tracker.isOperational) {
      fireAndForget(this.triggerSnapshotPush(), 'SnapshotPusher:handlePostPushScheduling')
    }
  }

  async flushPendingSnapshots(): Promise<SnapshotPushResult> {
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
    this.pendingPushRequested = false
    this.pushGuard.clear()
    this.retryStrategy.reset()
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
