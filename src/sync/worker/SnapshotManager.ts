import { debounce } from 'lodash-es'
import type { Repo } from '@automerge/automerge-repo/slim'

import type { VaultSnapshotInput } from '../../shared/schemas/snapshots'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import type { SyncMessageBroker } from './SyncMessageBroker'
import { buildSnapshot } from './snapshotBuilder'
import { ItemId } from 'src/shared/schemas/items'
import { LastModifiedStore } from './stores/LastModifiedStore'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
}

export class SnapshotManager {
  private dirtyItems = new Set<ItemId>()
  private lastModifiedByItemId = new Map<ItemId, number>()
  private snapshotPushInFlight = false
  private snapshotPushPending = false
  private snapshotRequestCursor: number | null = null
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private readonly retryDelays = [2000, 5000, 10000, 30000, 60000]
  private readonly maxPayloadBytes: number

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
    },
    private readonly lastModifiedStore: LastModifiedStore,
    options?: SnapshotManagerOptions,
  ) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 200 * 1024
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
    this.dirtyItems.add(itemId)
    this.flushDirtyDocumentsToIndexDebounced()
  }

  async flushDirtyDocumentsToIndex(): Promise<void> {
    const dirtyItemIds = Array.from(this.dirtyItems)
    if (dirtyItemIds.length === 0) {
      return
    }

    const timestamp = Date.now()

    for (const itemId of dirtyItemIds) {
      this.lastModifiedByItemId.set(itemId, timestamp)
    }
    this.saveLastModifiedDebounced()
  }

  scheduleSnapshotPush(cursor: number) {
    this.snapshotRequestCursor = cursor
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
    if (this.snapshotPushInFlight) {
      this.snapshotPushPending = true
      return
    }

    void this.pushSnapshots()
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
      if (this.snapshotRequestCursor !== null) {
        void this.pushSnapshots()
      }
    }, delayMs)
  }

  onOnlineStateChange(isOnline: boolean) {
    if (isOnline) {
      if (this.snapshotRequestCursor !== null && this.dirtyItems.size > 0) {
        this.retryAttempt = 0
        if (this.retryTimeoutId !== null) {
          clearTimeout(this.retryTimeoutId)
          this.retryTimeoutId = null
        }
        void this.pushSnapshots()
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
    if (this.snapshotRequestCursor === null) {
      return null
    }

    const authToken = await getActiveSessionToken()
    if (!authToken) {
      return null
    }

    const dirtyItemIds = Array.from(this.dirtyItems)
    if (dirtyItemIds.length === 0) {
      this.snapshotRequestCursor = null
      return null
    }

    return {
      accountId: this.deps.accountId,
      authToken,
      dirtyItemIds,
      snapshotCursor: this.snapshotRequestCursor,
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
        for (const snapshot of batch) {
          this.dirtyItems.delete(snapshot.itemId)
        }
        return { success: true, persisted: response.persisted }
      }
      return { success: false, persisted: 0 }
    } catch (error) {
      console.error('[SnapshotManager] Failed to put snapshots', error)
      return { success: false, persisted: 0 }
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
    let currentBatch: VaultSnapshotInput[] = []
    let currentBatchBytes = 0

    for (const itemId of dirtyItemIds) {
      const snapshot = await this.buildSnapshot(itemId, snapshotCursor)
      if (!snapshot) {
        success = false
        continue
      }

      const snapshotSize = JSON.stringify(snapshot).length

      // Check if we should flush the current batch before adding this snapshot.
      const wouldExceedCount = currentBatch.length >= 25
      const wouldExceedBytes = currentBatchBytes + snapshotSize > this.maxPayloadBytes

      if ((wouldExceedCount || wouldExceedBytes) && currentBatch.length > 0) {
        total += currentBatch.length
        const result = await this.sendSnapshotBatch(accountId, authToken, currentBatch)
        if (!result.success) {
          success = false
          sendFailed = true
          break
        }
        persisted += result.persisted
        currentBatch = []
        currentBatchBytes = 0
      }

      currentBatch.push(snapshot)
      currentBatchBytes += snapshotSize
    }

    // Flush any remaining items in the batch
    if (!sendFailed && currentBatch.length > 0) {
      total += currentBatch.length
      const result = await this.sendSnapshotBatch(accountId, authToken, currentBatch)
      if (!result.success) {
        success = false
      } else {
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
      const hasCursor = this.snapshotRequestCursor !== null

      if (!success && hasDirtyDocs && hasCursor) {
        this.scheduleRetry()
      }

      if (this.snapshotPushPending) {
        this.snapshotPushPending = false
        if (this.snapshotRequestCursor !== null) {
          this.scheduleSnapshotPush(this.snapshotRequestCursor)
        }
      }
    }
  }

  private async buildSnapshot(itemId: ItemId, snapshotCursor: number): Promise<VaultSnapshotInput | null> {
    try {
      return await buildSnapshot(this.deps.repo, itemId, snapshotCursor)
    } catch (error) {
      console.error('[SnapshotManager] failed to encrypt snapshot binary', error)
      return null
    }
  }

  async shutdown(): Promise<void> {
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }

    if (this.dirtyItems.size > 0) {
      try {
        await this.flushDirtyDocumentsToIndex()
      } catch (error) {
        console.error('[SnapshotManager] Failed to flush dirty documents during shutdown', error)
      }
    }

    await this.persistLastModified()

    this.clear()
  }

  clear() {
    this.saveLastModifiedDebounced.cancel()
    this.flushDirtyDocumentsToIndexDebounced.cancel()
    this.dirtyItems.clear()
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
