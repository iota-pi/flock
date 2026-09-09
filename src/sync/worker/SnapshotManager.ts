import { debounce } from 'lodash-es'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { buildSnapshot, isTransientVaultError, type BuildSnapshotResult } from './snapshotBuilder'
import { ItemId } from 'src/shared/schemas/items'
import { LastModifiedStore, type ItemSyncTimestamps } from './stores/LastModifiedStore'
import type { ClientEventHub } from './SyncEventHub'
import {
  readManualRecoveryEntries,
  removeManualRecoveryEntryByItemId,
  upsertManualRecoveryEntry,
} from '../shared/manualRecoveryStore'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
  debounceDelayMs?: number
  maxWaitMs?: number
}

interface SnapshotPushResult {
  persisted: number
  total: number
  success: boolean
}

const MAX_CONSECUTIVE_SNAPSHOT_FAILURES = 5

export class SnapshotManager {
  private dirtyItems = new Map<ItemId, number>()
  private dirtyItemsTick = 0
  private consecutiveFailures = new Map<ItemId, number>()
  private lastModifiedByItemId = new Map<ItemId, number>()
  private lastSnapshotAtByItemId = new Map<ItemId, number>()
  private oversizedItems = new Set<ItemId>()
  private snapshotPushPending = false
  private activePushPromise: Promise<SnapshotPushResult> | null = null
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
      eventHub?: ClientEventHub
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
      const stored = await this.lastModifiedStore.loadTimestamps()
      if (stored && Array.isArray(stored)) {
        for (const [itemId, ts] of stored) {
          this.lastModifiedByItemId.set(itemId, ts.localModifiedAt)
          if (typeof ts.lastSnapshotAt === 'number') {
            this.lastSnapshotAtByItemId.set(itemId, ts.lastSnapshotAt)
          }
        }
      }

      let quarantinedIds = new Set<ItemId>()
      if (this.deps.accountId) {
        try {
          const recoveryEntries = await readManualRecoveryEntries(this.deps.accountId)
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
          console.error('[SnapshotManager] Failed to read manual recovery entries during startup audit', recoveryErr)
        }
      }

      // Startup Dirty Audit: Re-enqueue un-snapshotted items (excluding quarantined items)
      let auditCount = 0
      for (const [itemId, localMod] of this.lastModifiedByItemId.entries()) {
        if (quarantinedIds.has(itemId)) {
          continue
        }
        const lastSnap = this.lastSnapshotAtByItemId.get(itemId) ?? 0
        if (localMod > lastSnap) {
          this.dirtyItemsTick += 1
          this.dirtyItems.set(itemId, this.dirtyItemsTick)
          auditCount++
        }
      }
      if (auditCount > 0) {
        console.info(`[SnapshotManager] Startup audit restored ${auditCount} un-snapshotted items to dirty queue`)
        this.scheduleDebouncedSnapshotPush()
      }
    } catch (error) {
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
    if (!itemId) return
    this.dirtyItemsTick += 1
    this.dirtyItems.set(itemId, this.dirtyItemsTick)
    this.flushDirtyDocumentsToIndexDebounced()
    this.scheduleDebouncedSnapshotPush(customDebounceDelayMs)
  }

  recordInboundChange(itemId: ItemId, timestamp: number = Date.now()): void {
    if (!itemId) return
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
    if (this.dirtyItems.size === 0 && !this.activePushPromise) {
      return { persisted: 0, total: 0 }
    }

    let persisted = 0
    let total = 0

    while (this.activePushPromise || this.dirtyItems.size > 0) {
      if (this.activePushPromise) {
        const result = await this.activePushPromise
        persisted += result.persisted
        total += result.total
        if (!result.success || (result.persisted === 0 && this.dirtyItems.size > 0)) {
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
    if (this.activePushPromise) {
      this.snapshotPushPending = true
      const res = await this.activePushPromise
      return { persisted: res.persisted, total: res.total }
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
    dirtyItemIds: ItemId[]
    snapshotCursor: number
  } | null> {
    const dirtyItemIds = Array.from(this.dirtyItems.keys())
    if (dirtyItemIds.length === 0) {
      this.snapshotRequestCursor = null
      return null
    }

    const authToken = await getActiveSessionToken()
    if (!authToken) {
      console.warn('[SnapshotManager] Cannot push snapshots: missing active session token')
      return null
    }

    const snapshotCursor = this.snapshotRequestCursor ?? (this.deps.getLatestCursor ? this.deps.getLatestCursor() : 0)

    return {
      accountId: this.deps.accountId,
      authToken,
      dirtyItemIds,
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

      if (response?.success && response.persisted === batch.length) {
        return { success: true, persisted: response.persisted }
      }
      return { success: false, persisted: response?.persisted ?? 0 }
    } catch (error) {
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
          await upsertManualRecoveryEntry(this.deps.accountId, {
            itemId,
            reason: `Snapshot failure: ${detailedReason}`,
          })
          const entries = await readManualRecoveryEntries(this.deps.accountId)
          this.deps.eventHub?.emit({ type: 'recoveryItemsChanged', entries })
        } catch (recoveryError) {
          console.error('[SnapshotManager] Failed to record manual recovery entry', recoveryError)
        }
      }
    } else {
      this.consecutiveFailures.set(itemId, failures)
    }
  }

  private async processSnapshotPush(context: {
    accountId: string
    authToken: string
    dirtyItemIds: ItemId[]
    snapshotCursor: number
  }): Promise<{ persisted: number; total: number; success: boolean }> {
    const { accountId, authToken, dirtyItemIds, snapshotCursor } = context
    let persisted = 0
    let total = 0
    let success = true
    let sendFailed = false
    let currentBatch: { snapshot: VaultSnapshotInput; tick: number; heads?: string[] }[] = []
    let currentBatchBytes = 0

    for (const itemId of dirtyItemIds) {
      const tick = this.dirtyItems.get(itemId)
      if (tick === undefined) {
        continue
      }

      const buildResult = await this.buildSnapshot(itemId, snapshotCursor)
      if (buildResult.type === 'not-ready') {
        success = false
        continue
      }

      if (buildResult.type === 'error') {
        success = false
        await this.handleSnapshotFailure(itemId, tick, 'build', buildResult.reason)
        continue
      }

      const snapshot = buildResult.snapshot
      this.consecutiveFailures.delete(itemId)

      const snapshotSize = JSON.stringify(snapshot).length

      if (snapshotSize > this.maxPayloadBytes) {
        const isAlreadyOversized = this.oversizedItems.has(itemId)
        this.oversizedItems.add(itemId)

        // Unconditionally remove from dirtyItems to avoid infinite retry loops
        this.dirtyItems.delete(itemId)

        // Advance lastSnapshotAt to localModifiedAt to prevent startup audit / sync loops while quarantined
        const localMod = this.lastModifiedByItemId.get(itemId) ?? snapshot.modified
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
          void upsertManualRecoveryEntry(accountId, {
            itemId,
            reason: `Snapshot size (${Math.round(snapshotSize / 1024)} KB) exceeds 350 KB limit. History compaction is required to resume sync.`,
          })
            .then(async () => {
              const entries = await readManualRecoveryEntries(accountId)
              this.deps.eventHub?.emit({ type: 'recoveryItemsChanged', entries })
            })
            .catch(() => {})
        }
        continue
      }

      this.oversizedItems.delete(itemId)

      // Check if we should flush the current batch before adding this snapshot.
      const wouldExceedCount = currentBatch.length >= 25
      const wouldExceedBytes = currentBatchBytes + snapshotSize > Math.min(this.maxPayloadBytes, 2 * 1024 * 1024)

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
          break
        }
        for (const item of currentBatch) {
          if (this.dirtyItems.get(item.snapshot.itemId) === item.tick) {
            this.dirtyItems.delete(item.snapshot.itemId)
          }
          this.lastSnapshotAtByItemId.set(item.snapshot.itemId, item.snapshot.modified)
          if (item.heads && item.heads.length > 0) {
            this.deps.broker.setSyncedHeadsForItem?.(item.snapshot.itemId, item.heads)
          }
          void removeManualRecoveryEntryByItemId(accountId, item.snapshot.itemId).catch(() => {})
        }
        this.saveLastModifiedDebounced()
        persisted += result.persisted
        currentBatch = []
        currentBatchBytes = 0
      }

      currentBatch.push({ snapshot, tick, heads: buildResult.heads })
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
      } else {
        for (const item of currentBatch) {
          if (this.dirtyItems.get(item.snapshot.itemId) === item.tick) {
            this.dirtyItems.delete(item.snapshot.itemId)
          }
          this.lastSnapshotAtByItemId.set(item.snapshot.itemId, item.snapshot.modified)
          if (item.heads && item.heads.length > 0) {
            this.deps.broker.setSyncedHeadsForItem?.(item.snapshot.itemId, item.heads)
          }
          void removeManualRecoveryEntryByItemId(accountId, item.snapshot.itemId).catch(() => {})
        }
        this.saveLastModifiedDebounced()
        persisted += result.persisted
      }
    }

    return { persisted, total, success }
  }

  private startPush(): Promise<SnapshotPushResult> {
    if (this.activePushPromise) {
      this.snapshotPushPending = true
      return this.activePushPromise
    }

    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }

    const pushPromise = this.executePush()
    this.activePushPromise = pushPromise
    return pushPromise
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    const res = await this.startPush()
    return { persisted: res.persisted, total: res.total }
  }

  private async executePush(): Promise<SnapshotPushResult> {
    let persisted = 0
    let total = 0
    let success = true

    try {
      const context = await this.preparePushContext()
      if (!context) {
        if (this.dirtyItems.size > 0) {
          success = false
        }
        return { persisted: 0, total: 0, success }
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

      return { persisted, total, success }
    } catch (error) {
      console.error('[SnapshotManager] Error during pushSnapshots', error)
      success = false
      return { persisted, total, success }
    } finally {
      this.activePushPromise = null

      const hasDirtyDocs = this.dirtyItems.size > 0

      if (!success && hasDirtyDocs) {
        this.scheduleRetry()
      }

      if (this.snapshotPushPending && hasDirtyDocs) {
        this.snapshotPushPending = false
        void this.triggerSnapshotPush()
      } else {
        this.snapshotPushPending = false
      }
    }
  }

  private async buildSnapshot(itemId: ItemId, snapshotCursor: number): Promise<BuildSnapshotResult> {
    try {
      return await buildSnapshot(this.deps.repo, itemId, snapshotCursor)
    } catch (error: any) {
      if (isTransientVaultError(error)) {
        console.warn('[SnapshotManager] Vault is locked or uninitialized during snapshot build, waiting', error)
        return { type: 'not-ready' }
      }
      console.error('[SnapshotManager] failed to encrypt snapshot binary', error)
      return { type: 'error', reason: error?.message || 'Failed to encrypt snapshot binary' }
    }
  }

  async shutdown(): Promise<void> {
    if (this.activePushPromise) {
      try {
        await this.activePushPromise
      } catch {}
    }
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
    this.lastSnapshotAtByItemId.clear()
    this.oversizedItems.clear()
    this.snapshotPushPending = false
    this.snapshotRequestCursor = null
    this.activePushPromise = null
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
    this.retryAttempt = 0
  }

  clearOversized(itemId: ItemId): void {
    this.oversizedItems.delete(itemId)
  }

  exportLastModified(): [ItemId, number][] {
    return Array.from(this.lastModifiedByItemId.entries())
  }

  async importLastModified(data: [ItemId, number][]): Promise<void> {
    this.lastModifiedByItemId = new Map(data)
    for (const [itemId, mod] of data) {
      this.lastSnapshotAtByItemId.set(itemId, mod)
    }
    await this.persistLastModified()
  }
}
