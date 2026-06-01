import { debounce } from 'lodash-es'
import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'
import type { VaultSnapshotInput } from '../shared/schemas/snapshots'
import {
  ACCOUNT_INDEX_DOCUMENT_ID,
  AutomergeIndexDocument,
  normalizeItemSnapshot,
  withAutomergeDocumentChange,
} from '../sync/automergeDocStore'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'
import { getVaultKey, type CryptoResult } from '../api/vault'
import { encryptBytesWithKey } from 'src/api/vault/crypto'
import { getActiveSessionToken } from '../sync/workerAuthStore'
import { putSnapshotsWithToken } from '../api/vault/SyncWorkerClient'
import { normalizeSnapshotType, isPlainObject } from './utils'
import type { VaultEncryptedNetworkAdapter } from 'src/sync/VaultEncryptedNetworkAdapter'

export class SnapshotManager {
  private dirtyDocuments = new Set<string>()
  private lastModifiedByItemId = new Map<string, number>()
  private snapshotPushInFlight = false
  private snapshotPushPending = false
  private snapshotRequestCursor: number | null = null

  private readonly flushDirtyDocumentsToIndexDebounced = debounce(
    () => void this.flushDirtyDocumentsToIndex(),
    1000,
  )

  constructor(
    private getContext: () => {
      accountId: string | null
      repo: Repo | null
      adapter: VaultEncryptedNetworkAdapter | null
    }
  ) {}

  markDocumentDirty(documentId: string) {
    if (!documentId) return
    this.dirtyDocuments.add(documentId)
    this.flushDirtyDocumentsToIndexDebounced()
  }

  processIndexChangelog(indexDoc: AutomergeIndexDocument, itemIds: string[]) {
    const { adapter } = this.getContext()
    if (!adapter) return

    const nextItemIdSet = new Set(itemIds)
    for (const itemId of this.lastModifiedByItemId.keys()) {
      if (!nextItemIdSet.has(itemId)) {
        this.lastModifiedByItemId.delete(itemId)
      }
    }

    const lastModified = indexDoc.lastModified
    if (!isPlainObject(lastModified)) {
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
      }
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
  }

  scheduleSnapshotPush(cursor: number) {
    this.snapshotRequestCursor = cursor
    if (this.snapshotPushInFlight) {
      this.snapshotPushPending = true
      return
    }

    void this.pushSnapshots()
  }

  async pushSnapshots(): Promise<{ persisted: number; total: number }> {
    if (this.snapshotPushInFlight) {
      this.snapshotPushPending = true
      return { persisted: 0, total: 0 }
    }

    this.snapshotPushInFlight = true

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

      let persisted = 0
      let total = 0

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
        }
      }

      if (persisted > 0) {
        this.snapshotRequestCursor = null
      }

      return { persisted, total }
    } finally {
      this.snapshotPushInFlight = false
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

    const documentUrl = await toAutomergeUrlFromItemId(itemId)
    const handle = await repo.find(documentUrl).catch(() => undefined)
    if (!handle) {
      return null
    }

    await handle.whenReady(['ready', 'unavailable'])
    if (!handle.isReady() || handle.isUnavailable()) {
      return null
    }

    const doc = handle.doc()
    if (!doc) {
      return null
    }

    const binary = Automerge.save(doc)
    if (!binary || binary.byteLength === 0) {
      return null
    }

    let encryptedDoc: CryptoResult
    try {
      encryptedDoc = await encryptBytesWithKey(getVaultKey(), binary)
    } catch (error) {
      console.error('[SnapshotManager] failed to encrypt snapshot binary', error)
      return null
    }

    const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>)
    if (!itemSnapshot) {
      return null
    }

    return {
      itemId,
      snapshot: encryptedDoc,
      snapshotCursor,
      type: normalizeSnapshotType(itemSnapshot.type, (itemSnapshot as any).originalType),
      modified: Date.now(),
      deleted: itemSnapshot.deleted === true || undefined,
    }
  }

  clear() {
    this.dirtyDocuments.clear()
    this.lastModifiedByItemId.clear()
    this.snapshotPushInFlight = false
    this.snapshotPushPending = false
    this.snapshotRequestCursor = null
  }
}
