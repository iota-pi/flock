import type { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import { buildSnapshot } from './snapshotBuilder'

const MAX_BATCH_RETRIES = 3

export interface ReencryptDeps {
  accountId: string
  repo: Repo
  indexManager: AutomergeIndexManager
}

export async function reencryptAllItems(
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  if (!deps.accountId || !deps.repo || !deps.indexManager) {
    throw new Error('SyncWorker not initialized')
  }
  const authToken = await getActiveSessionToken()
  if (!authToken) {
    throw new Error('No active session token available')
  }

  const itemIds = await deps.indexManager.listAutomergeItemIds()
    const total = itemIds.length
    if (total === 0) {
      if (onProgress) {
        onProgress(0, 0)
      }
      return
    }

    const snapshotCursor = Date.now()
    const batchSize = 10
    const errors: Error[] = []

    for (let start = 0; start < total; start += batchSize) {
      const chunkIds = itemIds.slice(start, start + batchSize)
      const snapshotPromises = chunkIds.map(async itemId => {
        let lastError: unknown = null
        for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
          try {
            return await buildSnapshot(deps.repo, itemId, snapshotCursor)
          } catch (err) {
            lastError = err
            console.warn(
              `[reencryptAllItems] Attempt ${attempt} failed to build snapshot for item ${itemId}:`,
              err
            )
          }
        }
        throw lastError
      })
      const settled = await Promise.allSettled(snapshotPromises)

      const snapshots = []
      for (const [index, result] of settled.entries()) {
        if (result.status === 'fulfilled') {
          if (result.value.type === 'success') {
            snapshots.push(result.value.snapshot)
          } else if (result.value.type === 'not-ready') {
            console.warn(`[reencryptAllItems] Item ${chunkIds[index]} was not ready. Skipping.`)
          } else if (result.value.type === 'error') {
            const errMsg = `Failed to build snapshot for item ${chunkIds[index]}`
            console.error(`[reencryptAllItems] ${errMsg}`)
            errors.push(new Error(errMsg))
          }
        } else {
          const errMsg = `Failed to build snapshot for item ${chunkIds[index]}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`
          console.error(`[reencryptAllItems] ${errMsg}`, result.reason)
          errors.push(result.reason instanceof Error ? result.reason : new Error(errMsg))
        }
      }

      if (snapshots.length > 0) {
        let uploadSuccess = false
        let lastError: unknown = null

        for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
          try {
            const response = await putSnapshotsWithToken({
              account: deps.accountId,
              authToken,
              snapshots,
            })

            if (response?.success) {
              uploadSuccess = true
              break
            }
          } catch (err) {
            lastError = err
            console.warn(
              `[reencryptAllItems] Attempt ${attempt} failed to upload snapshots for batch at index ${start}:`,
              err
            )
          }
        }

        if (!uploadSuccess) {
          const errMsg =
            `Failed to upload snapshots for batch starting at index ${start} after ${MAX_BATCH_RETRIES} attempts` +
            (lastError instanceof Error ? `: ${lastError.message}` : '')
          console.error(`[reencryptAllItems] ${errMsg}`)
          errors.push(new Error(errMsg))
        }
      }

      if (onProgress) {
        const done = Math.min(start + batchSize, total)
        onProgress(done, total)
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Re-encryption completed with ${errors.length} error(s). First error: ${errors[0].message}`
      )
    }
}
