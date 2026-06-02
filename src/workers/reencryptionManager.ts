/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Automerge from '@automerge/automerge/slim'
import type { Repo } from '@automerge/automerge-repo/slim'
import {
  listAutomergeItemIds,
  normalizeItemSnapshot,
} from '../sync/automergeDocStore'
import { encryptBytes } from '../api/vault'
import { toAutomergeUrlFromItemId } from '../sync/automergeRepoIds'
import { getActiveSessionToken } from '../sync/workerAuthStore'
import { putSnapshotsWithToken } from '../api/vault/SyncWorkerClient'
import { normalizeSnapshotType } from './utils'

export class ReencryptionManager {
  constructor(
    private getContext: () => {
      accountId: string | null
      repo: Repo | null
    }
  ) {}

  async reencryptAllItems(onProgress?: (done: number, total: number) => void): Promise<void> {
    const { accountId, repo } = this.getContext()
    if (!accountId || !repo) {
      throw new Error('SyncWorker not initialized')
    }
    const authToken = await getActiveSessionToken()
    if (!authToken) {
      throw new Error('No active session token available')
    }

    const itemIds = await listAutomergeItemIds(accountId)
    const total = itemIds.length
    if (total === 0) {
      if (onProgress) {
        onProgress(0, 0)
      }
      return
    }

    const snapshotCursor = Date.now()
    const batchSize = 10

    for (let start = 0; start < total; start += batchSize) {
      const chunkIds = itemIds.slice(start, start + batchSize)
      const snapshots: any[] = []

      for (const itemId of chunkIds) {
        const documentUrl = await toAutomergeUrlFromItemId(itemId)
        const handle = await repo.find(documentUrl).catch(() => undefined)
        if (!handle) continue

        await handle.whenReady(['ready', 'unavailable'])
        if (!handle.isReady() || handle.isUnavailable()) continue

        const doc = handle.doc()
        if (!doc) continue

        const binary = Automerge.save(doc)
        if (!binary || binary.byteLength === 0) continue

        const encryptedDoc = await encryptBytes(binary)

        const itemSnapshot = normalizeItemSnapshot(itemId, doc as Record<string, unknown>)
        if (!itemSnapshot) continue

        snapshots.push({
          itemId,
          snapshot: encryptedDoc,
          snapshotCursor,
          type: normalizeSnapshotType(itemSnapshot.type, (itemSnapshot as any).originalType),
          modified: Date.now(),
          deleted: itemSnapshot.deleted === true || undefined,
        })
      }

      if (snapshots.length > 0) {
        const response = await putSnapshotsWithToken({
          account: accountId,
          authToken,
          snapshots,
        })

        if (!response?.success) {
          throw new Error(`Failed to upload snapshots for batch starting at index ${start}`)
        }
      }

      if (onProgress) {
        const done = Math.min(start + batchSize, total)
        onProgress(done, total)
      }
    }
  }
}
