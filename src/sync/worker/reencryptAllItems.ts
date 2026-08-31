import type { Repo } from '@automerge/automerge-repo/slim'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import { buildSnapshot } from './snapshotBuilder'
import { upsertManualRecoveryEntry } from '../shared/manualRecoveryStore'
import type { ItemId } from 'src/shared/schemas/items'
import type { EncryptedSnapshot } from 'src/shared/schemas/vault'

const MAX_BATCH_RETRIES = 3

export interface ReencryptDeps {
  accountId: string
  repo: Repo
  indexManager: AutomergeIndexManager
}

export interface ReencryptResult {
  succeeded: ItemId[]
  failed: Array<{ itemId: ItemId; error: string }>
}

export async function reencryptAllItems(
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): Promise<ReencryptResult> {
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
    return { succeeded: [], failed: [] }
  }

  const snapshotCursor = Date.now()
  const batchSize = 10
  const succeeded: ItemId[] = []
  const failed: Array<{ itemId: ItemId; error: string }> = []

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

    const readySnapshots: Array<{ itemId: ItemId; snapshot: EncryptedSnapshot }> = []
    for (const [index, result] of settled.entries()) {
      const itemId = chunkIds[index]
      if (result.status === 'fulfilled') {
        if (result.value.type === 'success') {
          readySnapshots.push({ itemId, snapshot: result.value.snapshot })
        } else if (result.value.type === 'not-ready') {
          console.warn(`[reencryptAllItems] Item ${itemId} was not ready. Skipping.`)
        } else if (result.value.type === 'error') {
          const errMsg = `Failed to build snapshot for item ${itemId}`
          console.error(`[reencryptAllItems] ${errMsg}`)
          failed.push({ itemId, error: errMsg })
          try {
            await upsertManualRecoveryEntry(deps.accountId, {
              itemId,
              reason: `Re-encryption snapshot build failed: ${errMsg}`,
            })
          } catch (storageErr) {
            console.error(`[reencryptAllItems] Failed to quarantine item ${itemId}:`, storageErr)
          }
        }
      } else {
        const errMsg = `Failed to build snapshot for item ${itemId}: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`
        console.error(`[reencryptAllItems] ${errMsg}`, result.reason)
        failed.push({ itemId, error: errMsg })
        try {
          await upsertManualRecoveryEntry(deps.accountId, {
            itemId,
            reason: `Re-encryption snapshot build failed: ${errMsg}`,
          })
        } catch (storageErr) {
          console.error(`[reencryptAllItems] Failed to quarantine item ${itemId}:`, storageErr)
        }
      }
    }

    if (readySnapshots.length > 0) {
      let uploadSuccess = false
      let lastError: unknown = null

      for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
        try {
          const response = await putSnapshotsWithToken({
            account: deps.accountId,
            authToken,
            snapshots: readySnapshots.map(r => r.snapshot),
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

      if (uploadSuccess) {
        for (const item of readySnapshots) {
          succeeded.push(item.itemId)
        }
      } else {
        const errMsg =
          `Failed to upload snapshots for batch starting at index ${start} after ${MAX_BATCH_RETRIES} attempts` +
            (lastError instanceof Error ? `: ${lastError.message}` : '')
        console.error(`[reencryptAllItems] ${errMsg}`)
        for (const item of readySnapshots) {
          failed.push({ itemId: item.itemId, error: errMsg })
          try {
            await upsertManualRecoveryEntry(deps.accountId, {
              itemId: item.itemId,
              reason: `Re-encryption upload failed: ${errMsg}`,
            })
          } catch (storageErr) {
            console.error(`[reencryptAllItems] Failed to quarantine item ${item.itemId}:`, storageErr)
          }
        }
      }
    }

    if (onProgress) {
      const done = Math.min(start + batchSize, total)
      onProgress(done, total)
    }
  }

  return { succeeded, failed }
}
