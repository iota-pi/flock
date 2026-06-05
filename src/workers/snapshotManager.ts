import { debounce } from 'lodash-es'
import type { Repo } from '@automerge/automerge-repo/slim'
import localforage from 'localforage'
import { isQuotaError } from 'src/utils/storageQuota'
import { reportQuotaExceeded } from './quotaReporter'

import type { VaultSnapshotInput } from '../shared/schemas/snapshots'
import {
  ACCOUNT_INDEX_DOCUMENT_ID,
  AutomergeIndexDocument,
  withAutomergeDocumentChange,
} from '../sync/automergeDocStore'
import { getActiveSessionToken } from '../sync/workerAuthStore'
import { putSnapshotsWithToken } from '../api/vault/SyncWorkerClient'
import { isPlainObject } from './utils'
import type { VaultEncryptedNetworkAdapter } from 'src/sync/VaultEncryptedNetworkAdapter'
import { buildSnapshot } from './snapshotBuilder'

export interface SnapshotManagerOptions {
  maxPayloadBytes?: number
}

export class SnapshotManager {
  private dirtyDocuments = new Set<string>()
  private lastModifiedByItemId = new Map<string, number>()
  private snapshotPushInFlight = false
  private snapshotPushPending = false
  private snapshotRequestCursor: number | null = null
  private lastModifiedStore: LocalForage | null = null
  private retryTimeoutId: any = null
  private retryAttempt = 0
  private readonly retryDelays = [2000, 5000, 10000, 30000, 60000]
  private readonly maxPayloadBytes: number

  private readonly flushDirtyDocumentsToIndexDebounced = debounce(
    () => void this.flushDirtyDocumentsToIndex(),
    1000,
  )

  private readonly saveLastModifiedDebounced = debounce(() => void this.persistLastModified(), 1000)

  constructor(
    private getContext: () => {
      accountId: string | null
      repo: Repo | null
      adapter: VaultEncryptedNetworkAdapter | null
    },
    options?: SnapshotManagerOptions,
  ) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? 200 * 1024
  }

  async loadLastModified(accountId: string): Promise<void> {
    this.lastModifiedStore = localforage.createInstance({
      name: 'flock-sync-last-modified',
      storeName: `last-modified-${accountId}`,
    })
    try {
      const stored = await this.lastModifiedStore.getItem<[string, number][]>('lastModifiedByItemId')
      if (stored && Array.isArray(stored)) {
        this.lastModifiedByItemId = new Map(stored)
      }
    } catch (error) {
      console.error('[SnapshotManager] Failed to load lastModified timestamps', error)
    }
  }

  async persistLastModified(): Promise<void> {
    if (!this.lastModifiedStore) return
    const data = Array.from(this.lastModifiedByItemId.entries())
    try {
      await this.lastModifiedStore.setItem('lastModifiedByItemId', data)
    } catch (error) {
      console.error('[SnapshotManager] Failed to save lastModified timestamps', error)
      if (isQuotaError(error)) {
        reportQuotaExceeded()
      }
    }
  }

  markDocumentDirty(documentId: string) {
    if (!documentId) return
    this.dirtyDocuments.add(documentId)
    this.flushDirtyDocumentsToIndexDebounced()
  }

  processIndexChangelog(indexDoc: AutomergeIndexDocument, itemIds: string[]) {
    const { adapter } = this.getContext()
    if (!adapter) return

    let changed = false
    const nextItemIdSet = new Set(itemIds)
    for (const itemId of this.lastModifiedByItemId.keys()) {
      if (!nextItemIdSet.has(itemId)) {
        this.lastModifiedByItemId.delete(itemId)
        changed = true
      }
    }

    const lastModified = indexDoc.lastModified
    if (!isPlainObject(lastModified)) {
      if (changed) {
        this.saveLastModifiedDebounced()
      }
      return
    }

    const pendingPullItems: string[] = []

    for (const [itemId, rawTimestamp] of Object.entries(lastModified)) {
      if (!nextItemIdSet.has(itemId)) continue
      if (itemId === ACCOUNT_INDEX_DOCUMENT_ID) continue
      if (typeof rawTimestamp !== 'number' || !Number.isFinite(rawTimestamp)) continue

      const currentTimestamp = this.lastModifiedByItemId.get(itemId) || 0
      if (rawTimestamp > currentTimestamp) {
        this.lastModifiedByItemId.set(itemId, rawTimestamp)
        pendingPullItems.push(itemId)
        changed = true
      }
    }

    if (changed) {
      this.saveLastModifiedDebounced()
    }

    if (pendingPullItems.length > 0) {
      adapter.queuePendingPullItems(pendingPullItems)
    }
  }

  async flushDirtyDocumentsToIndex(): Promise<void> {
    const { accountId } = this.getContext()
    if (!accountId) return

    const dirtyItemIds = Array.from(this.dirtyDocuments).filter(
      itemId => itemId && itemId !== ACCOUNT_INDEX_DOCUMENT_ID,
    )

    if (dirtyItemIds.length === 0) {
      return
    }

    const timestamp = Date.now()

    await withAutomergeDocumentChange(
      accountId,
      ACCOUNT_INDEX_DOCUMENT_ID,
      doc => {
        let lastModified = isPlainObject((doc as AutomergeIndexDocument).lastModified)
          ? ((doc as AutomergeIndexDocument).lastModified as Record<string, number>)
          : null
        if (!lastModified) {
          lastModified = {}
          doc.lastModified = lastModified
        }

        for (const itemId of dirtyItemIds) {
          lastModified[itemId] = timestamp
        }
      },
      {
        createIfMissing: true,
        initialValue: {
          accountId: '',
          itemIds: [],
          metadata: {},
          lastModified: {},
        },
      },
    ).catch(error => {
      console.error('[SnapshotManager] failed to update index lastModified', error)
    })

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
    this.retryAttempt++

    console.log(`[SnapshotManager] Scheduling snapshot push retry (attempt ${this.retryAttempt}) in ${delayMs}ms`)

    this.retryTimeoutId = setTimeout(() => {
      this.retryTimeoutId = null
      if (this.snapshotRequestCursor !== null) {
        void this.pushSnapshots()
      }
    }, delayMs)
  }

  onOnlineStateChange(isOnline: boolean) {
    if (isOnline) {
      if (this.snapshotRequestCursor !== null && this.dirtyDocuments.size > 0) {
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
    dirtyItemIds: string[]
    snapshotCursor: number
  } | null> {
    if (this.snapshotRequestCursor === null) {
      return null
    }

    const { accountId, repo } = this.getContext()
    if (!accountId || !repo) {
      return null
    }

    const authToken = await getActiveSessionToken()
    if (!authToken) {
      return null
    }

    if (this.dirtyDocuments.has(ACCOUNT_INDEX_DOCUMENT_ID)) {
      this.dirtyDocuments.delete(ACCOUNT_INDEX_DOCUMENT_ID)
    }

    const dirtyItemIds = Array.from(this.dirtyDocuments)
    if (dirtyItemIds.length === 0) {
      this.snapshotRequestCursor = null
      return null
    }

    return {
      accountId,
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
          this.dirtyDocuments.delete(snapshot.itemId)
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
    dirtyItemIds: string[]
    snapshotCursor: number
  }): Promise<{ persisted: number; total: number; success: boolean }> {
    const { accountId, authToken, dirtyItemIds, snapshotCursor } = context
    let persisted = 0
    let total = 0
    let success = true
    let currentBatch: VaultSnapshotInput[] = []
    let currentBatchBytes = 0

    for (const itemId of dirtyItemIds) {
      const snapshot = await this.buildSnapshot(itemId, snapshotCursor)
      if (!snapshot) continue

      const snapshotSize = JSON.stringify(snapshot).length

      // Check if we should flush the current batch before adding this snapshot.
      // Compliance with:
      // 1. Max array length of 25 snapshots (PutSnapshotBatchSchema limitation).
      // 2. Max payload bytes. We only check payload bytes if currentBatch is not empty,
      //    so that a single snapshot that exceeds the byte limit can still be pushed.
      const wouldExceedCount = currentBatch.length >= 25
      const wouldExceedBytes = currentBatchBytes + snapshotSize > this.maxPayloadBytes

      if ((wouldExceedCount || wouldExceedBytes) && currentBatch.length > 0) {
        total += currentBatch.length
        const result = await this.sendSnapshotBatch(accountId, authToken, currentBatch)
        if (!result.success) {
          success = false
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
    if (success && currentBatch.length > 0) {
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

      if (persisted > 0) {
        this.snapshotRequestCursor = null
      }

      if (success && this.dirtyDocuments.size === 0) {
        this.retryAttempt = 0
      }

      return { persisted, total }
    } catch (error) {
      console.error('[SnapshotManager] Error during pushSnapshots', error)
      success = false
      return { persisted, total }
    } finally {
      this.snapshotPushInFlight = false

      const hasDirtyDocs = this.dirtyDocuments.size > 0
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

  private async buildSnapshot(itemId: string, snapshotCursor: number): Promise<VaultSnapshotInput | null> {
    const { repo, accountId } = this.getContext()
    if (!repo || !accountId) {
      return null
    }

    try {
      return await buildSnapshot(repo, itemId, snapshotCursor)
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

    if (this.dirtyDocuments.size > 0) {
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
    this.dirtyDocuments.clear()
    this.lastModifiedByItemId.clear()
    this.snapshotPushInFlight = false
    this.snapshotPushPending = false
    this.snapshotRequestCursor = null
    if (this.retryTimeoutId !== null) {
      clearTimeout(this.retryTimeoutId)
      this.retryTimeoutId = null
    }
    this.retryAttempt = 0
    if (this.lastModifiedStore) {
      this.lastModifiedStore.removeItem('lastModifiedByItemId').catch(error => {
        console.error('[SnapshotManager] Failed to clear persisted lastModified timestamps', error)
      })
      this.lastModifiedStore = null
    }
  }

  exportLastModified(): [string, number][] {
    return Array.from(this.lastModifiedByItemId.entries())
  }

  async importLastModified(data: [string, number][]): Promise<void> {
    if (!this.lastModifiedStore) return
    this.lastModifiedByItemId = new Map(data)
    await this.lastModifiedStore.setItem('lastModifiedByItemId', data)
  }
}
