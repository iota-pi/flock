import type { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeDocStore } from './docStore'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import { buildSnapshot } from './snapshotBuilder'

export class ReencryptionManager {
  constructor(
    private deps: {
      accountId: string
      repo: Repo
      docStore: AutomergeDocStore
    }
  ) {}

  async reencryptAllItems(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (!this.deps.accountId || !this.deps.repo || !this.deps.docStore) {
      throw new Error('SyncWorker not initialized')
    }
    const authToken = await getActiveSessionToken()
    if (!authToken) {
      throw new Error('No active session token available')
    }

    const itemIds = await this.deps.docStore.listAutomergeItemIds()
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
      const snapshots = (await Promise.all(snapshotPromises)).filter(s => s !== null)

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
