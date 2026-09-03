import { debounce } from 'lodash-es'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { buildSnapshot, type BuildSnapshotResult } from './snapshotBuilder'
import { ItemId } from 'src/shared/schemas/items'
import { LastModifiedStore } from './stores/LastModifiedStore'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
}

const MAX_CONSECUTIVE_SNAPSHOT_FAILURES = 5

export class SnapshotManager {
  private dirtyItems = new Map<ItemId, number>()
  private dirtyItemsTick = 0
  private consecutiveFailures = new Map<ItemId, number>()
  private lastModifiedByItemId = new Map<ItemId, number>()
  private snapshotPushInFlight = false
  private snapshotPushPending = false
  private snapshotRequestCursor: number | null = null
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private readonly retryDelays = [2000, 5000, 10000, 30000, 60000]
  private readonly maxPayloadBytes: number

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
    },
    private readonly lastModifiedStore: LastModifiedStore,
    options?: SnapshotManagerOptions,
  ) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 350 * 1024
    this.debounceDelayMs = options?.debounceDelayMs ?? 30_000
    this.maxWaitMs = options?.maxWaitMs ?? 5 * 60 * 1000
  }

  async loadLastModified(): Promise<void> {
    try {
      const stored = await this.lastModifiedStore.loadLastModified()
      if (stored && Array.isArray(stored)) {
        this.lastModifiedByItemId = new Map(stored)
      }
    } catch (error) {
      console.error('[SnapshotManager] Failed to load lastModified timestamps', error)
    }
  }

  async persistLastModified(): Promise<void> {
    const data = Array.from(this.lastModifiedByItemId.entries())
    try {
      await this.lastModifiedStore.saveLastModified(data)
    } catch (error) {
      console.error('[SnapshotManager] Failed to save lastModified timestamps', error)
    }
  }

  markItemDirty(itemId: ItemId) {
    if (!itemId) return
    this.dirtyItemsTick += 1
    this.dirtyItems.set(itemId, this.dirtyItemsTick)
    this.flushDirtyDocumentsToIndexDebounced()
    this.scheduleDebouncedSnapshotPush()
  }

  private scheduleDebouncedSnapshotPush() {
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
    }, this.debounceDelayMs)
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
    if (this.dirtyItems.size === 0 && !this.snapshotPushInFlight) {
      return { persisted: 0, total: 0 }
    }
    return this.triggerSnapshotPush()
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
    if (typeof cursor === 'number') {
      this.snapshotRequestCursor = cursor
    }
    void this.triggerSnapshotPush()
  }

  async triggerSnapshotPush(): Promise<{ persisted: number; total: number }> {
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
    if (this.snapshotPushInFlight) {
      this.snapshotPushPending = true
      return { persisted: 0, total: 0 }
    }

    return this.pushSnapshots()
  }

  private scheduleRetry() {
    if (this.retryTimeoutId !== null) {
      return
    }

    const delayMs = this.retryDelays[Math.min(this.retryAttempt, this.retryDelays.length - 1)]
    this.retryAttempt += 1

    console.warn(`[SnapshotManager] Scheduling snapshot push retry (attempt ${this.retryAttempt}) in ${delayMs}ms`)

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null
      if (this.dirtyItems.size > 0) {
        void this.pushSnapshots()
      }
    }, delayMs)
  }

  onOnlineStateChange(isOnline: boolean) {
    if (isOnline) {
      if (this.dirtyItems.size > 0) {
        this.retryAttempt = 0
        if (this.retryTimeoutId !== null) {
          clearTimeout(this.retryTimeoutId)
          this.retryTimeoutId = null
        }
        void this.triggerSnapshotPush()
      }
    } else {
      if (this.retryTimeoutId !== null) {
        clearTimeout(this.retryTimeoutId)
        this.retryTimeoutId = null
      }
    }
  }

  private async preparePushContext(): Promise<{
    accountId: string
    authToken: string
    dirtyItems: { itemId: ItemId; tick: number }[]
    snapshotCursor: number
  } | null> {
    const authToken = await getActiveSessionToken()
    if (!authToken) {
      return null
    }

    const dirtyItems = Array.from(this.dirtyItems.entries()).map(([itemId, tick]) => ({ itemId, tick }))
    if (dirtyItems.length === 0) {
      this.snapshotRequestCursor = null
      return null
    }

    const snapshotCursor = this.snapshotRequestCursor ?? (this.deps.getLatestCursor ? this.deps.getLatestCursor() : 0)

    return {
      accountId: this.deps.accountId,
      authToken,
      dirtyItems,
      snapshotCursor,
    }
  }

  private async sendSnapshotBatch(
    accountId: string,
    authToken: string,
    batch: VaultSnapshotInput[],
  ): Promise<{ success: boolean; persisted: number }> {
    if (batch.length === 0) {
      return { success: true, persisted: 0 }
    }
    try {
      const response = await putSnapshotsWithToken({
        account: accountId,
        authToken,
        snapshots: batch,
      })

      if (response?.success) {
        return { success: true, persisted: response.persisted }
      }
      return { success: false, persisted: 0 }
    } catch (error) {
      console.error('[SnapshotManager] Failed to put snapshots', error)
      return { success: false, persisted: 0 }
    }
  }

  private handleSnapshotFailure(itemId: ItemId, tick: number, failureType: string) {
    const failures = (this.consecutiveFailures.get(itemId) ?? 0) + 1
    if (failures >= MAX_CONSECUTIVE_SNAPSHOT_FAILURES) {
      console.error(
        `[SnapshotManager] Item ${itemId} reached max consecutive snapshot ${failureType} failures (${MAX_CONSECUTIVE_SNAPSHOT_FAILURES}). Removing from dirty queue.`
      )
      this.consecutiveFailures.delete(itemId)
      if (this.dirtyItems.get(itemId) === tick) {
        this.dirtyItems.delete(itemId)
      }
    } else {
      this.consecutiveFailures.set(itemId, failures)
    }
  }

  private async processSnapshotPush(context: {
    accountId: string
    authToken: string
    dirtyItems: { itemId: ItemId; tick: number }[]
    snapshotCursor: number
  }): Promise<{ persisted: number; total: number; success: boolean }> {
    const { accountId, authToken, dirtyItems, snapshotCursor } = context
    let persisted = 0
    let total = 0
    let success = true
    let sendFailed = false
    let currentBatch: { snapshot: VaultSnapshotInput; tick: number }[] = []
    let currentBatchBytes = 0

    for (const { itemId, tick } of dirtyItems) {
      const buildResult = await this.buildSnapshot(itemId, snapshotCursor)
      if (buildResult.type === 'not-ready') {
        success = false
        continue
      }

      if (buildResult.type === 'error') {
        success = false
        this.handleSnapshotFailure(itemId, tick, 'build')
        continue
      }

      const snapshot = buildResult.snapshot
      this.consecutiveFailures.delete(itemId)

      const snapshotSize = JSON.stringify(snapshot).length

      if (snapshotSize > this.maxPayloadBytes) {
        console.error(
          `[SnapshotManager] Snapshot for item ${itemId} exceeds maxPayloadBytes (${snapshotSize} > ${this.maxPayloadBytes}). Skipping.`
        )
        success = false
        if (this.dirtyItems.get(itemId) === tick) {
          this.dirtyItems.delete(itemId)
        }
        continue
      }

      // Check if we should flush the current batch before adding this snapshot.
      const wouldExceedCount = currentBatch.length >= 25
      const wouldExceedBytes = currentBatchBytes + snapshotSize > this.maxPayloadBytes

      if ((wouldExceedCount || wouldExceedBytes) && currentBatch.length > 0) {
        total += currentBatch.length
        const result = await this.sendSnapshotBatch(
          accountId,
          authToken,
          currentBatch.map(b => b.snapshot),
        )
        if (!result.success) {
          success = false
          sendFailed = true
          for (const item of currentBatch) {
            this.handleSnapshotFailure(item.snapshot.itemId, item.tick, 'send')
          }
          break
        }
        for (const item of currentBatch) {
          if (this.dirtyItems.get(item.snapshot.itemId) === item.tick) {
            this.dirtyItems.delete(item.snapshot.itemId)
          }
        }
        persisted += result.persisted
        currentBatch = []
        currentBatchBytes = 0
      }

      currentBatch.push({ snapshot, tick })
      currentBatchBytes += snapshotSize
    }

    // Flush any remaining items in the batch
    if (!sendFailed && currentBatch.length > 0) {
      total += currentBatch.length
      const result = await this.sendSnapshotBatch(
        accountId,
        authToken,
        currentBatch.map(b => b.snapshot),
      )
      if (!result.success) {
        success = false
        for (const item of currentBatch) {
          this.handleSnapshotFailure(item.snapshot.itemId, item.tick, 'send')
        }
      } else {
        for (const item of currentBatch) {
          if (this.dirtyItems.get(item.snapshot.itemId) === item.tick) {
            this.dirtyItems.delete(item.snapshot.itemId)
          }
        }
        persisted += result.persisted
      }
    }

    return { persisted, total, success }
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    if (this.snapshotPushInFlight) {
      this.snapshotPushPending = true
      return { persisted: 0, total: 0 }
    }

    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }

    this.snapshotPushInFlight = true
    let persisted = 0
    let total = 0
    let success = true

    try {
      const context = await this.preparePushContext()
      if (!context) {
        return { persisted: 0, total: 0 }
      }

      const result = await this.processSnapshotPush(context)
      persisted = result.persisted
      total = result.total
      success = result.success

      if (success) {
        this.snapshotRequestCursor = null
      }

      if (success && this.dirtyItems.size === 0) {
        this.retryAttempt = 0
      }

      return { persisted, total }
    } catch (error) {
      console.error('[SnapshotManager] Error during pushSnapshots', error)
      success = false
      return { persisted, total }
    } finally {
      this.snapshotPushInFlight = false

      const hasDirtyDocs = this.dirtyItems.size > 0

      if (!success && hasDirtyDocs) {
        this.scheduleRetry()
      }

      if (this.snapshotPushPending) {
        this.snapshotPushPending = false
        void this.triggerSnapshotPush()
      }
    }
  }

  private async buildSnapshot(itemId: ItemId, snapshotCursor: number): Promise<BuildSnapshotResult> {
    try {
      return await buildSnapshot(this.deps.repo, itemId, snapshotCursor)
    } catch (error) {
      console.error('[SnapshotManager] failed to encrypt snapshot binary', error)
      return { type: 'error' }
    }
  }

  async shutdown(): Promise<void> {
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }

    if (this.dirtyItems.size > 0) {
      this.updateLastModifiedForDirtyItems()
    }

    await this.persistLastModified()

    this.clear()
  }

  clear() {
    this.clearDebounceTimers()
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()
    this.dirtyItems.clear()
    this.consecutiveFailures.clear()
    this.lastModifiedByItemId.clear()
    this.snapshotPushInFlight = false
    this.snapshotPushPending = false
    this.snapshotRequestCursor = null
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
    this.retryAttempt = 0
  }

  exportLastModified(): [ItemId, number][] {
    return Array.from(this.lastModifiedByItemId.entries())
  }

  async importLastModified(data: [ItemId, number][]): Promise<void> {
    this.lastModifiedByItemId = new Map(data)
    await this.lastModifiedStore.saveLastModified(data)
  }
}
