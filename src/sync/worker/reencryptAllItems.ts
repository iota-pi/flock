import type { Repo } from '@automerge/automerge-repo/slim'
import { chunk } from 'lodash'

import { AutomergeIndexManager } from './docStore'
import { buildSnapshot } from './snapshotBuilder'
import { RecoveryManager } from './RecoveryManager'
import { SyncApiClient } from './SyncApiClient'
import { isAuthError } from './utils/auth'
import { isNetworkError } from './utils/network'
import { isServerError } from './utils/server'
import { RetryStrategy, DEFAULT_RETRY_DELAYS } from '../utils/RetryStrategy'
import type { ItemId } from 'src/shared/schemas/items'
import type { VaultSnapshotInput } from 'src/shared/schemas/snapshots'

const MAX_BATCH_RETRIES = 3
export const REENCRYPT_RETRY_DELAYS = DEFAULT_RETRY_DELAYS
const reencryptRetryStrategy = new RetryStrategy({ delays: DEFAULT_RETRY_DELAYS })

let scheduledRetryTimeoutId: ReturnType<typeof setTimeout> | null = null

export function cancelScheduledReencryption(): void {
  if (scheduledRetryTimeoutId !== null) {
    clearTimeout(scheduledRetryTimeoutId)
    scheduledRetryTimeoutId = null
  }
  reencryptRetryStrategy.reset()
}

function scheduleReencryptRetry(
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): number {
  const delayMs = reencryptRetryStrategy.nextDelay()

  console.warn(
    `[reencryptAllItems] Scheduling re-encryption retry (attempt ${reencryptRetryStrategy.attempt}) in ${delayMs}ms`
  )

  if (deps.scheduleRetry) {
    deps.scheduleRetry(delayMs)
  } else {
    if (scheduledRetryTimeoutId !== null) {
      clearTimeout(scheduledRetryTimeoutId)
    }
    scheduledRetryTimeoutId = setTimeout(() => {
      scheduledRetryTimeoutId = null
      void reencryptAllItems(deps, onProgress).catch(err => {
        console.warn('[reencryptAllItems] Scheduled retry failed:', err)
      })
    }, delayMs)
  }

  return delayMs
}

function toAuthExpiredError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  return new Error(`Re-encryption aborted: authentication session expired (${message})`, {
    cause: err,
  })
}

async function quarantineItem(
  recoveryManager: RecoveryManager,
  accountId: string,
  itemId: ItemId,
  reason: string
): Promise<void> {
  try {
    await recoveryManager.quarantine(accountId, itemId, reason)
  } catch (storageErr) {
    console.error(`[reencryptAllItems] Failed to quarantine item ${itemId}:`, storageErr)
  }
}


export interface ReencryptDeps {
  accountId: string
  repo: Repo
  indexManager: AutomergeIndexManager
  apiClient?: SyncApiClient
  getAuthToken?: () => Promise<string | null>
  refreshAuthToken?: () => Promise<string | null>
  scheduleRetry?: (delayMs?: number) => void
  recoveryManager?: RecoveryManager
}

export interface ReencryptResult {
  succeeded: ItemId[]
  failed: Array<{ itemId: ItemId; error: string }>
}

async function buildSingleSnapshotWithRetry(repo: Repo, itemId: ItemId) {
  let retries = 0
  let lastError: Error | null = null
  while (retries < MAX_BATCH_RETRIES) {
    try {
      return await buildSnapshot(repo, itemId, 0)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      retries += 1
      console.warn(
        `[reencryptAllItems] Retry ${retries}/${MAX_BATCH_RETRIES} building snapshot for ${itemId}:`,
        err
      )
    }
  }
  throw lastError
}

async function buildSnapshotsForChunk(
  repo: Repo,
  chunkIds: ItemId[]
): Promise<{
  readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>
  failureDetails: Array<{ itemId: ItemId; errorMsg: string; rawError?: unknown }>
}> {
  const settled = await Promise.allSettled(
    chunkIds.map(itemId => buildSingleSnapshotWithRetry(repo, itemId))
  )

  const readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }> = []
  const failureDetails: Array<{ itemId: ItemId; errorMsg: string; rawError?: unknown }> = []

  for (const [index, result] of settled.entries()) {
    const itemId = chunkIds[index]
    if (result.status === 'fulfilled') {
      if (result.value.type === 'success') {
        readySnapshots.push({ itemId, snapshot: result.value.snapshot })
      } else if (result.value.type === 'not-ready') {
        console.warn(`[reencryptAllItems] Item ${itemId} was not ready. Skipping.`)
      } else if (result.value.type === 'error') {
        const errorMsg = result.value.reason
          ? `Failed to build snapshot for item ${itemId}: ${result.value.reason}`
          : `Failed to build snapshot for item ${itemId}`
        failureDetails.push({ itemId, errorMsg })
      }
    } else {
      const errorDetail =
        result.reason instanceof Error ? result.reason.message : String(result.reason)
      failureDetails.push({
        itemId,
        errorMsg: `Failed to build snapshot for item ${itemId}: ${errorDetail}`,
        rawError: result.reason,
      })
    }
  }

  return { readySnapshots, failureDetails }
}

async function uploadSnapshotBatchWithRetry(
  apiClient: SyncApiClient,
  accountId: string,
  readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }>
): Promise<{ uploadSuccess: boolean; lastError: unknown }> {
  let uploadSuccess = false
  let lastError: unknown = null

  for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
    try {
      const response = await apiClient.putSnapshots({
        account: accountId,
        snapshots: readySnapshots.map(r => r.snapshot),
      })

      if (
        response?.success &&
        (response.persisted === undefined || response.persisted === readySnapshots.length)
      ) {
        uploadSuccess = true
        break
      }
    } catch (err) {
      lastError = err
      console.warn(
        `[reencryptAllItems] Attempt ${attempt} failed to upload snapshots for batch:`,
        err
      )

      if (isAuthError(err)) {
        throw toAuthExpiredError(err)
      }

      if (isNetworkError(err) || isServerError(err)) {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          break
        }
      }
    }
  }

  return { uploadSuccess, lastError }
}

function handleBatchUploadFailure(
  lastError: unknown,
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): string {
  if (isAuthError(lastError)) {
    throw toAuthExpiredError(lastError)
  }

  if (isNetworkError(lastError) || isServerError(lastError)) {
    const errMsg = lastError instanceof Error ? lastError.message : String(lastError)
    const errorType = isServerError(lastError) ? 'server error' : 'network error'
    console.warn(
      `[reencryptAllItems] Transient ${errorType} during upload: ${errMsg}. Aborting operation and scheduling retry.`
    )
    scheduleReencryptRetry(deps, onProgress)
    throw new Error(
      `Re-encryption aborted: ${errorType} (${errMsg})`,
      { cause: lastError }
    )
  }

  return (
    `Failed to upload snapshots for batch after ${MAX_BATCH_RETRIES} attempts` +
    (lastError instanceof Error ? `: ${lastError.message}` : '')
  )
}

// Use a slightly smaller upload chunk size than in SnapshotManager to improve progress reporting granularity
const REENCRYPT_CHUNK_SIZE = 10

export async function reencryptAllItems(
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): Promise<ReencryptResult> {
  if (!deps?.accountId || !deps?.repo || !deps?.indexManager) {
    throw new Error('SyncWorker not initialized')
  }

  const { accountId, repo, indexManager } = deps
  const recoveryManager = deps.recoveryManager ?? new RecoveryManager({ accountId })
  const apiClient = deps.apiClient ?? new SyncApiClient({
    getAuthToken: deps.getAuthToken,
    refreshAuthToken: deps.refreshAuthToken,
  })
  const initialToken = await apiClient.getValidToken()
  if (!initialToken) {
    throw new Error('No active session token available')
  }

  const allItemIds = await indexManager.listAutomergeItemIds()
  const total = allItemIds.length
  if (total === 0) {
    if (onProgress) {
      onProgress(0, 0)
    }
    reencryptRetryStrategy.reset()
    return { succeeded: [], failed: [] }
  }

  let processed = 0
  const succeeded: ItemId[] = []
  const failed: Array<{ itemId: ItemId; error: string }> = []

  const itemChunks = chunk(allItemIds, REENCRYPT_CHUNK_SIZE)

  for (const chunkIds of itemChunks) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const errMsg = 'Network is offline'
      console.warn(`[reencryptAllItems] Aborting: ${errMsg}`)
      scheduleReencryptRetry(deps, onProgress)
      throw new Error(`Re-encryption aborted: network error (${errMsg})`)
    }

    await apiClient.syncLatestToken()

    const { readySnapshots, failureDetails } = await buildSnapshotsForChunk(repo, chunkIds)
    for (const failure of failureDetails) {
      if (failure.rawError !== undefined) {
        console.error(`[reencryptAllItems] ${failure.errorMsg}`, failure.rawError)
      } else {
        console.error(`[reencryptAllItems] ${failure.errorMsg}`)
      }
      failed.push({ itemId: failure.itemId, error: failure.errorMsg })
      await quarantineItem(
        recoveryManager,
        accountId,
        failure.itemId,
        `Re-encryption snapshot build failed: ${failure.errorMsg}`
      )
    }

    if (readySnapshots.length > 0) {
      const { uploadSuccess, lastError } = await uploadSnapshotBatchWithRetry(
        apiClient,
        accountId,
        readySnapshots
      )

      if (uploadSuccess) {
        for (const item of readySnapshots) {
          succeeded.push(item.itemId)
        }
      } else {
        const errMsg = handleBatchUploadFailure(lastError, deps, onProgress)
        console.error(`[reencryptAllItems] ${errMsg}`)
        for (const item of readySnapshots) {
          failed.push({ itemId: item.itemId, error: errMsg })
          await quarantineItem(
            recoveryManager,
            accountId,
            item.itemId,
            `Re-encryption upload failed: ${errMsg}`
          )
        }
      }
    }

    processed += chunkIds.length
    if (onProgress) {
      onProgress(Math.min(processed, total), total)
    }
  }

  reencryptRetryStrategy.reset()
  return { succeeded, failed }
}
