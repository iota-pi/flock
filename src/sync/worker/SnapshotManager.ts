import { debounce } from 'lodash-es'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { SyncApiClient } from './SyncApiClient'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { buildSnapshot, type BuildSnapshotResult } from './snapshotBuilder'
import { isTransientVaultError } from './utils/vaultErrors'
import { ItemId } from 'src/shared/schemas/items'
import { LastModifiedStore, type ItemSyncTimestamps } from './stores/LastModifiedStore'
import type { ClientEventHub } from './SyncEventHub'
import { RecoveryManager } from './RecoveryManager'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import { checkAlive, isAbortError } from './utils/abort'
import {
  SnapshotBatchAccumulator,
  estimateSnapshotSize,
  type PreparedSnapshotItem,
} from './SnapshotBatchAccumulator'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
  isLeader?: boolean
}

interface SnapshotPushResult {
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

export class SnapshotManager {
  private isShutdown = false
  private isLeader = false
  private isOnline = true
  private pushAbortController: AbortController | null = null
  private dirtyItems = new Map<ItemId, number>()
  private dirtyItemsTick = 0
  private consecutiveFailures = new Map<ItemId, number>()
  private lastModifiedByItemId = new Map<ItemId, number>()
  private lastSnapshotAtByItemId = new Map<ItemId, number>()
  private oversizedItems = new Set<ItemId>()
  private snapshotPushPending = false
  private readonly pushGuard = new SingleFlightGuard<SnapshotPushResult>()
  private snapshotRequestCursor: number | null = null
  private readonly loadGuard = new SingleFlightGuard<void>()
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null
  private readonly retryStrategy = new RetryStrategy({ delays: DEFAULT_RETRY_DELAYS })
  private get retryAttempt(): number {
    return this.retryStrategy.attempt
  }

  private set retryAttempt(val: number) {
    this.retryStrategy.attempt = val
  }

  private get retryDelays(): readonly number[] {
    return this.retryStrategy.delays
  }

  private readonly maxPayloadBytes: number
  private readonly recoveryManager: RecoveryManager
  private readonly apiClient: SyncApiClient

  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  private readonly debounceDelayMs: number
  private readonly maxWaitMs: number

  private readonly flushDirtyDocumentsToIndexDebounced = debounce(
    () => void this.flushDirtyDocumentsToIndex(),
    1000,
  )

  private readonly saveLastModifiedDebounced = debounce(() => void this.persistLastModified(), 1000)

  constructor(
    private deps: {
      accountId: string
      repo: Repo
      broker: SyncMessageBroker
      getLatestCursor?: () => number
      eventHub?: ClientEventHub
      recoveryManager?: RecoveryManager
      apiClient?: SyncApiClient
    },
    private readonly lastModifiedStore: LastModifiedStore,
    options?: SnapshotManagerOptions,
  ) {
    this.apiClient = deps.apiClient ?? new SyncApiClient()
    this.recoveryManager = deps.recoveryManager ?? new RecoveryManager({
      accountId: deps.accountId,
      eventHub: deps.eventHub,
    })
    this.isLeader = options?.isLeader ?? false
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 350 * 1024
    this.debounceDelayMs = options?.debounceDelayMs ?? 30_000
    this.maxWaitMs = options?.maxWaitMs ?? 5 * 60 * 1000
  }

  get isOperational(): boolean {
    return !this.isShutdown && this.isLeader && this.isOnline
  }

  private abortPush(): void {
    if (this.pushAbortController) {
      this.pushAbortController.abort()
      this.pushAbortController = null
    }
  }

  async setLeader(isLeader: boolean): Promise<void> {
    if (this.isShutdown || this.isLeader === isLeader) {
      return
    }
    this.isLeader = isLeader

    if (isLeader) {
      if (this.dirtyItems.size > 0) {
        this.scheduleDebouncedSnapshotPush()
      }
      await this.loadLastModified()
    } else {
      this.clearDebounceTimers()
      this.abortPush()
      if (this.retryTimeoutId !== null) {
        clearTimeout(this.retryTimeoutId)
        this.retryTimeoutId = null
      }
    }
  }

  get leader(): boolean {
    return this.isLeader
  }

  async loadLastModified(): Promise<void> {
    if (this.isShutdown) return
    await this.loadGuard.run(() => this.executeLoadLastModified())
  }

  private async executeLoadLastModified(): Promise<void> {
    try {
      checkAlive(null, () => !this.isShutdown)
      const stored = await this.lastModifiedStore.loadTimestamps()
      checkAlive(null, () => !this.isShutdown)

      if (stored && Array.isArray(stored)) {
        for (const [itemId, ts] of stored) {
          const existingLocalMod = this.lastModifiedByItemId.get(itemId) ?? 0
          const lastSnap = typeof ts.lastSnapshotAt === 'number' ? ts.lastSnapshotAt : 0
          this.lastModifiedByItemId.set(itemId, Math.max(existingLocalMod, ts.localModifiedAt, lastSnap))
          if (typeof ts.lastSnapshotAt === 'number') {
            const existingLastSnap = this.lastSnapshotAtByItemId.get(itemId) ?? 0
            this.lastSnapshotAtByItemId.set(itemId, Math.max(existingLastSnap, ts.lastSnapshotAt))
          }
        }
      }

      const quarantinedIds = new Set<ItemId>()
      if (this.deps.accountId) {
        try {
          const recoveryEntries = await this.recoveryManager.listRecoveryItems(this.deps.accountId)
          checkAlive(null, () => !this.isShutdown)
          for (const entry of recoveryEntries) {
            quarantinedIds.add(entry.itemId)
            if (
              entry.reason?.toLowerCase().includes('limit') ||
              entry.reason?.toLowerCase().includes('exceeds')
            ) {
              this.oversizedItems.add(entry.itemId)
            }
          }
        } catch (recoveryErr) {
          if (isAbortError(recoveryErr)) throw recoveryErr
          console.error('[SnapshotManager] Failed to read manual recovery entries during startup audit', recoveryErr)
        }
      }

      checkAlive(null, () => !this.isShutdown)

      // Startup & Promotion Dirty Audit: Re-enqueue un-snapshotted items (excluding quarantined items)
      let auditCount = 0
      for (const [itemId, localMod] of this.lastModifiedByItemId.entries()) {
        if (quarantinedIds.has(itemId)) {
          continue
        }
        const lastSnap = this.lastSnapshotAtByItemId.get(itemId) ?? 0
        if (localMod > lastSnap) {
          if (!this.dirtyItems.has(itemId)) {
            this.dirtyItemsTick += 1
            this.dirtyItems.set(itemId, this.dirtyItemsTick)
            auditCount += 1
          }
        }
      }
      if (auditCount > 0) {
        console.info(`[SnapshotManager] Startup audit restored ${auditCount} un-snapshotted items to dirty queue`)
        this.scheduleDebouncedSnapshotPush()
      }
    } catch (error) {
      if (isAbortError(error) || this.isShutdown) return
      console.error('[SnapshotManager] Failed to load lastModified timestamps', error)
    }
  }

  async persistLastModified(): Promise<void> {
    const data: [ItemId, ItemSyncTimestamps][] = Array.from(this.lastModifiedByItemId.entries()).map(
      ([itemId, localModifiedAt]) => [
        itemId,
        {
          localModifiedAt,
          lastSnapshotAt: this.lastSnapshotAtByItemId.get(itemId),
        },
      ],
    )
    try {
      await this.lastModifiedStore.saveTimestamps(data)
    } catch (error) {
      console.error('[SnapshotManager] Failed to save lastModified timestamps', error)
    }
  }

  markItemDirty(itemId: ItemId, customDebounceDelayMs?: number) {
    if (this.isShutdown || !itemId) return
    this.dirtyItemsTick += 1
    this.dirtyItems.set(itemId, this.dirtyItemsTick)
    this.flushDirtyDocumentsToIndexDebounced()
    this.scheduleDebouncedSnapshotPush(customDebounceDelayMs)
  }

  recordInboundChange(itemId: ItemId, timestamp: number = Date.now()): void {
    if (this.isShutdown || !itemId) return
    this.lastModifiedByItemId.set(itemId, timestamp)
    this.saveLastModifiedDebounced()
  }

  getLastSnapshotAt(itemId: ItemId): number | undefined {
    return this.lastSnapshotAtByItemId.get(itemId)
  }

  getLocalModifiedAt(itemId: ItemId): number | undefined {
    return this.lastModifiedByItemId.get(itemId)
  }

  scheduleDebouncedSnapshotPush(customDelayMs?: number) {
    if (!this.isOperational) return
    if (this.retryTimeoutId !== null) return
    const delay = typeof customDelayMs === 'number' ? customDelayMs : this.debounceDelayMs
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
    }

    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = setTimeout(() => {
        this.clearDebounceTimers()
        void this.triggerSnapshotPush()
      }, this.maxWaitMs)
    }

    this.debounceTimer = setTimeout(() => {
      this.clearDebounceTimers()
      void this.triggerSnapshotPush()
    }, delay)
  }

  private clearDebounceTimers() {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.maxWaitTimer !== null) {
      clearTimeout(this.maxWaitTimer)
      this.maxWaitTimer = null
    }
  }

  async flushPendingSnapshots(): Promise<{ persisted: number; total: number }> {
    this.clearDebounceTimers()
    if (!this.isOperational) {
      return { persisted: 0, total: 0 }
    }
    if (this.dirtyItems.size === 0 && !this.pushGuard.isRunning) {
      return { persisted: 0, total: 0 }
    }

    let persisted = 0
    let total = 0

    while (this.pushGuard.isRunning || this.dirtyItems.size > 0) {
      if (this.pushGuard.isRunning) {
        const result = await this.pushGuard.waitForRunning()
        if (result) {
          persisted += result.persisted
          total += result.total
          if (!result.success || (result.persisted === 0 && this.dirtyItems.size > 0)) {
            break
          }
        } else {
          break
        }
      } else {
        const result = await this.startPush()
        persisted += result.persisted
        total += result.total
        if (!result.success || (result.persisted === 0 && this.dirtyItems.size > 0)) {
          break
        }
      }
    }

    return { persisted, total }
  }

  private updateLastModifiedForDirtyItems(): void {
    const dirtyItemIds = Array.from(this.dirtyItems.keys())
    if (dirtyItemIds.length === 0) {
      return
    }

    const timestamp = Date.now()

    for (const itemId of dirtyItemIds) {
      this.lastModifiedByItemId.set(itemId, timestamp)
    }
  }

  async flushDirtyDocumentsToIndex(): Promise<void> {
    this.updateLastModifiedForDirtyItems()
    this.saveLastModifiedDebounced()
  }

  scheduleSnapshotPush(cursor?: number) {
    if (!this.isOperational) return
    if (typeof cursor === 'number') {
      this.snapshotRequestCursor = cursor
    }
    void this.triggerSnapshotPush()
  }

  async triggerSnapshotPush(): Promise<{ persisted: number; total: number }> {
    if (!this.isOperational) {
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

  private scheduleRetry() {
    if (!this.isOperational || this.retryTimeoutId !== null) {
      return
    }

    this.clearDebounceTimers()

    const delayMs = this.retryStrategy.nextDelay()

    console.warn(`[SnapshotManager] Scheduling snapshot push retry (attempt ${this.retryAttempt}) in ${delayMs}ms`)

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null
      if (this.dirtyItems.size > 0) {
        void this.pushSnapshots()
      }
    }, delayMs)
  }

  onOnlineStateChange(isOnline: boolean) {
    this.isOnline = isOnline
    if (isOnline) {
      if (this.isLeader && this.dirtyItems.size > 0) {
        this.retryAttempt = 0
        if (this.retryTimeoutId !== null) {
          clearTimeout(this.retryTimeoutId)
          this.retryTimeoutId = null
        }
        void this.triggerSnapshotPush()
      }
    } else {
      this.abortPush()
      if (this.retryTimeoutId !== null) {
        clearTimeout(this.retryTimeoutId)
        this.retryTimeoutId = null
      }
    }
  }

  private async preparePushContext(): Promise<{
    accountId: string
    dirtyItemIds: ItemId[]
    snapshotCursor: number
  } | null> {
    if (!this.isOperational) {
      return null
    }
    const dirtyItemIds = Array.from(this.dirtyItems.keys())
    if (dirtyItemIds.length === 0) {
      this.snapshotRequestCursor = null
      return null
    }

    const hasToken = await this.apiClient.hasAuthToken()
    if (!hasToken) {
      console.warn('[SnapshotManager] Cannot push snapshots: missing active session token')
      return null
    }

    const snapshotCursor = this.snapshotRequestCursor ?? (this.deps.getLatestCursor ? this.deps.getLatestCursor() : 0)

    return {
      accountId: this.deps.accountId,
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
      console.error('[SnapshotManager] Failed to put snapshots', error)
      return { success: false, persisted: 0 }
    }
  }

  private async handleSnapshotFailure(
    itemId: ItemId,
    tick: number,
    failureType: string,
    reason?: string,
  ) {
    const failures = (this.consecutiveFailures.get(itemId) ?? 0) + 1
    if (failures >= MAX_CONSECUTIVE_SNAPSHOT_FAILURES) {
      const detailedReason =
        reason ||
        `Snapshot ${failureType} failed after ${MAX_CONSECUTIVE_SNAPSHOT_FAILURES} consecutive attempts`
      console.error(
        `[SnapshotManager] Item ${itemId} reached max consecutive snapshot ${failureType} failures (${MAX_CONSECUTIVE_SNAPSHOT_FAILURES}). Reason: ${detailedReason}. Moving to manual recovery.`
      )
      this.consecutiveFailures.delete(itemId)
      if (this.dirtyItems.get(itemId) === tick) {
        this.dirtyItems.delete(itemId)
      }

      this.deps.eventHub?.emit({
        type: 'snapshotFailed',
        itemId,
        message: `Snapshot sync failed for item ${itemId}: ${detailedReason}. Changes are stored locally only.`,
      })

      if (this.deps.accountId) {
        try {
          await this.recoveryManager.quarantine(
            this.deps.accountId,
            itemId,
            `Snapshot failure: ${detailedReason}`,
          )
        } catch (recoveryError) {
          console.error('[SnapshotManager] Failed to record manual recovery entry', recoveryError)
        }
      }
    } else {
      this.consecutiveFailures.set(itemId, failures)
    }
  }

  private handleOversizedItem(
    itemId: ItemId,
    snapshotSize: number,
    modified: number,
    accountId: string,
  ): void {
    const isAlreadyOversized = this.oversizedItems.has(itemId)
    this.oversizedItems.add(itemId)

    // Unconditionally remove from dirtyItems to avoid infinite retry loops
    this.dirtyItems.delete(itemId)

    // Advance lastSnapshotAt to localModifiedAt to prevent startup audit / sync loops while quarantined
    const localMod = this.lastModifiedByItemId.get(itemId) ?? modified
    this.lastSnapshotAtByItemId.set(itemId, localMod)
    this.saveLastModifiedDebounced()

    if (!isAlreadyOversized) {
      console.error(
        `[SnapshotManager] Snapshot for item ${itemId} exceeds maxPayloadBytes (${snapshotSize} > ${this.maxPayloadBytes}). Skipping.`
      )
      this.deps.eventHub?.emit({
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
    const tick = this.dirtyItems.get(itemId)
    if (tick === undefined) {
      return { type: 'skipped' }
    }

    const buildResult = await this.buildSnapshot(itemId, snapshotCursor)
    if (buildResult.type === 'not-ready') {
      return { type: 'not-ready' }
    }

    if (buildResult.type === 'error') {
      await this.handleSnapshotFailure(itemId, tick, 'build', buildResult.reason)
      return { type: 'error' }
    }

    const snapshot = buildResult.snapshot
    this.consecutiveFailures.delete(itemId)

    const snapshotSize = estimateSnapshotSize(snapshot)

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
      if (this.dirtyItems.get(item.snapshot.itemId) === item.tick) {
        this.dirtyItems.delete(item.snapshot.itemId)
      }
      this.lastSnapshotAtByItemId.set(item.snapshot.itemId, item.snapshot.modified)
      const currentLocalMod = this.lastModifiedByItemId.get(item.snapshot.itemId) ?? 0
      this.lastModifiedByItemId.set(
        item.snapshot.itemId,
        Math.max(currentLocalMod, item.snapshot.modified),
      )
      if (item.heads && item.heads.length > 0) {
        this.deps.broker.setSyncedHeads?.(item.snapshot.itemId, item.heads)
      }
      this.deps.broker.clearSnapshotOnlyItem?.(item.snapshot.itemId)
      this.deps.broker.unblockItem?.(item.snapshot.itemId)
      void this.recoveryManager.unquarantine(accountId, item.snapshot.itemId).catch(() => {})
    }
    this.saveLastModifiedDebounced()
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

    const accumulator = new SnapshotBatchAccumulator({
      maxBatchCount: 25,
      maxBatchBytes: this.maxPayloadBytes,
    })

    for (const itemId of dirtyItemIds) {
      checkAlive(signal, () => this.isOperational)
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
        checkAlive(signal, () => this.isOperational)
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
      checkAlive(signal, () => this.isOperational)
      const result = await this.flushBatch(batch, accountId, signal)
      persisted += result.persisted
      if (!result.success) {
        success = false
      }
    }

    return { persisted, total, success }
  }

  private startPush(): Promise<SnapshotPushResult> {
    if (!this.isOperational) {
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
    if (!this.isOperational) {
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
      checkAlive(signal, () => this.isOperational)
      const context = await this.preparePushContext()
      if (!context) {
        if (this.dirtyItems.size > 0) {
          success = false
        }
        return { persisted: 0, total: 0, success }
      }

      checkAlive(signal, () => this.isOperational)
      const result = await this.processSnapshotPush(context, signal)
      persisted = result.persisted
      total = result.total
      success = result.success

      if (success) {
        this.snapshotRequestCursor = null
      }

      if (success && this.dirtyItems.size === 0) {
        this.retryAttempt = 0
      }

      return { persisted, total, success }
    } catch (error) {
      if (signal.aborted || isAbortError(error) || !this.isOperational) {
        return { persisted, total, success: false }
      }
      console.error('[SnapshotManager] Error during pushSnapshots', error)
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
    const hasDirtyDocs = this.dirtyItems.size > 0

    if (!success && hasDirtyDocs && this.isOperational) {
      this.scheduleRetry()
    } else if (this.snapshotPushPending && hasDirtyDocs && this.isOperational) {
      void this.triggerSnapshotPush()
    }

    this.snapshotPushPending = false
  }

  private async buildSnapshot(itemId: ItemId, snapshotCursor: number): Promise<BuildSnapshotResult> {
    try {
      return await buildSnapshot(this.deps.repo, itemId, snapshotCursor)
    } catch (error: unknown) {
      if (isTransientVaultError(error)) {
        console.warn('[SnapshotManager] Vault is locked or uninitialized during snapshot build, waiting', error)
        return { type: 'not-ready' }
      }
      console.error('[SnapshotManager] failed to encrypt snapshot binary', error)
      return { type: 'error', reason: error instanceof Error ? error.message : 'Failed to encrypt snapshot binary' }
    }
  }

  async shutdown(options?: { clearLocalData?: boolean }): Promise<void> {
    if (this.isShutdown) return
    this.isShutdown = true
    this.isLeader = false
    this.abortPush()

    await this.pushGuard.waitForRunning()
    await this.loadGuard.waitForRunning()
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }

    if (!options?.clearLocalData) {
      if (this.dirtyItems.size > 0) {
        this.updateLastModifiedForDirtyItems()
      }
      await this.persistLastModified()
    }

    this.clear()
  }

  clear() {
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()
    this.dirtyItems.clear()
    this.consecutiveFailures.clear()
    this.lastModifiedByItemId.clear()
    this.lastSnapshotAtByItemId.clear()
    this.oversizedItems.clear()
    this.snapshotPushPending = false
    this.snapshotRequestCursor = null
    this.pushGuard.clear()
    this.loadGuard.clear()
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
    this.retryAttempt = 0
  }

  clearOversized(itemId: ItemId): void {
    this.oversizedItems.delete(itemId)
  }

  getDirtyItemIds(): ItemId[] {
    return Array.from(this.dirtyItems.keys())
  }

  exportLastModified(): [ItemId, number][] {
    const result: [ItemId, number][] = []
    const allIds = new Set([...this.lastModifiedByItemId.keys(), ...this.lastSnapshotAtByItemId.keys()])
    for (const id of allIds) {
      const localMod = this.lastModifiedByItemId.get(id) ?? 0
      const lastSnap = this.lastSnapshotAtByItemId.get(id) ?? 0
      result.push([id, Math.max(localMod, lastSnap)])
    }
    return result
  }

  async importLastModified(data: [ItemId, number][]): Promise<void> {
    for (const [itemId, mod] of data) {
      const existingLocalMod = this.lastModifiedByItemId.get(itemId)
      const existingLastSnap = this.lastSnapshotAtByItemId.get(itemId)

      const isUnsavedLocalEdit =
        existingLocalMod !== undefined &&
        existingLocalMod > (existingLastSnap ?? 0) &&
        mod <= existingLocalMod

      if (isUnsavedLocalEdit) {
        this.lastModifiedByItemId.set(itemId, Math.max(existingLocalMod, mod))
      } else {
        this.lastModifiedByItemId.set(itemId, mod)
        this.lastSnapshotAtByItemId.set(itemId, mod)
      }
    }
    await this.persistLastModified()
  }
}
