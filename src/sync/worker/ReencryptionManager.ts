import type { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import { buildSnapshot } from './snapshotBuilder'

export class ReencryptionManager {
  constructor(
    private deps: {
      accountId: string
      repo: Repo
      indexManager: AutomergeIndexManager
    }
  ) {}

  async reencryptAllItems(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.deps.accountId || !this.deps.repo || !this.deps.indexManager) {
      throw new Error('SyncWorker not initialized')
    }
    const authToken = await getActiveSessionToken()
    if (!authToken) {
      throw new Error('No active session token available')
    }

    const itemIds = await this.deps.indexManager.listAutomergeItemIds()
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
      const snapshotPromises = chunkIds.map(
        itemId => buildSnapshot(this.deps.repo, itemId, snapshotCursor)
      )
      const settled = await Promise.allSettled(snapshotPromises)

      const snapshots = []
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          if (result.value !== null) {
            snapshots.push(result.value)
          }
        } else {
          console.error(
            `[ReencryptionManager] Failed to build snapshot for item ${chunkIds[index]}:`,
            result.reason
          )
        }
      }

      if (snapshots.length > 0) {
        const response = await putSnapshotsWithToken({
          account: this.deps.accountId,
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
