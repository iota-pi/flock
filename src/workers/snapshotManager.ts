import { debounce } from 'lodash-es'
import * as Automerge from '@automerge/automerge/slim'
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

  private readonly flushDirtyDocumentsToIndexDebounced = debounce(
    () => void this.flushDirtyDocumentsToIndex(),
    1000,
  )

  private readonly saveLastModifiedDebounced = debounce(() => this.saveLastModified(), 1000)

  constructor(
    private getContext: () => {
      accountId: string | null
      repo: Repo | null
      adapter: VaultEncryptedNetworkAdapter | null
    }
  ) {}

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

  private saveLastModified(): void {
    if (!this.lastModifiedStore) return
    const data = Array.from(this.lastModifiedByItemId.entries())
    this.lastModifiedStore.setItem('lastModifiedByItemId', data).catch(error => {
      console.error('[SnapshotManager] Failed to save lastModified timestamps', error)
      if (isQuotaError(error)) {
        reportQuotaExceeded()
      }
    })
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
      if (this.snapshotRequestCursor === null) {
        return { persisted: 0, total: 0 }
      }

      const { accountId, repo } = this.getContext()
      if (!accountId || !repo) {
        return { persisted: 0, total: 0 }
      }

      const authToken = await getActiveSessionToken()
      if (!authToken) {
        return { persisted: 0, total: 0 }
      }

      if (this.dirtyDocuments.has(ACCOUNT_INDEX_DOCUMENT_ID)) {
        this.dirtyDocuments.delete(ACCOUNT_INDEX_DOCUMENT_ID)
      }

      const dirtyItemIds = Array.from(this.dirtyDocuments)
      if (dirtyItemIds.length === 0) {
        this.snapshotRequestCursor = null
        return { persisted: 0, total: 0 }
      }

      const snapshotCursor = this.snapshotRequestCursor

      for (let start = 0; start < dirtyItemIds.length; start += 25) {
        const slice = dirtyItemIds.slice(start, start + 25)
        const snapshots: VaultSnapshotInput[] = []

        for (const itemId of slice) {
          const snapshot = await this.buildSnapshot(itemId, snapshotCursor)
          if (snapshot) {
            snapshots.push(snapshot)
          }
        }

        if (snapshots.length === 0) {
          continue
        }

        total += snapshots.length

        try {
          const response = await putSnapshotsWithToken({
            account: accountId,
            authToken,
            snapshots,
          })

          if (response?.success) {
            persisted += response.persisted
            for (const snapshot of snapshots) {
              this.dirtyDocuments.delete(snapshot.itemId)
            }
          } else {
            success = false
          }
        } catch (error) {
          console.error('[SnapshotManager] Failed to put snapshots', error)
          success = false
          break
        }
      }

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

  clear() {
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
}
