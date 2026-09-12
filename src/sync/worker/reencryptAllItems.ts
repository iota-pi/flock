import type { Repo } from '@automerge/automerge-repo/slim'
import { chunk } from 'lodash'

import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { putSnapshotsWithToken } from '../../api/vault/SyncWorkerClient'
import { buildSnapshot } from './snapshotBuilder'
import { upsertManualRecoveryEntry } from '../shared/manualRecoveryStore'
import { isAuthError } from './utils/auth'
import { isNetworkError } from './utils/network'
import { isServerError } from './utils/server'
import type { ItemId } from 'src/shared/schemas/items'
import type { VaultSnapshotInput } from 'src/shared/schemas/snapshots'

const MAX_BATCH_RETRIES = 3
const REENCRYPT_RETRY_DELAYS = [2000, 5000, 10000, 30000, 60000]

let scheduledRetryTimeoutId: ReturnType<typeof setTimeout> | null = null
let scheduledRetryAttempt = 0

export function cancelScheduledReencryption(): void {
  if (scheduledRetryTimeoutId !== null) {
    clearTimeout(scheduledRetryTimeoutId)
    scheduledRetryTimeoutId = null
  }
  scheduledRetryAttempt = 0
}

function scheduleReencryptRetry(
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): number {
  const delayMs =
    REENCRYPT_RETRY_DELAYS[
      Math.min(scheduledRetryAttempt, REENCRYPT_RETRY_DELAYS.length - 1)
    ]
  scheduledRetryAttempt += 1

  console.warn(
    `[reencryptAllItems] Scheduling re-encryption retry (attempt ${scheduledRetryAttempt}) in ${delayMs}ms`
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
  accountId: string,
  itemId: ItemId,
  reason: string
): Promise<void> {
  try {
    await upsertManualRecoveryEntry(accountId, {
      itemId,
      reason,
    })
  } catch (storageErr) {
    console.error(`[reencryptAllItems] Failed to quarantine item ${itemId}:`, storageErr)
  }
}

export class ReencryptAuthManager {
  private currentToken: string | null = null
  private readonly getAuth: () => Promise<string | null>
  private readonly refreshAuth?: () => Promise<string | null>

  constructor(deps: Pick<ReencryptDeps, 'getAuthToken' | 'refreshAuthToken'>) {
    this.getAuth = deps.getAuthToken ?? getActiveSessionToken
    this.refreshAuth = deps.refreshAuthToken
  }

  async getInitialToken(): Promise<string> {
    this.currentToken = await this.getAuth()
    if (!this.currentToken && this.refreshAuth) {
      try {
        this.currentToken = await this.refreshAuth()
      } catch (refreshErr) {
        console.warn('[reencryptAllItems] Initial token refresh callback failed:', refreshErr)
      }
    }
    if (!this.currentToken) {
      throw new Error('No active session token available')
    }
    return this.currentToken
  }

  async syncLatestToken(): Promise<string> {
    const latest = await this.getAuth()
    if (latest) {
      this.currentToken = latest
    }
    return this.currentToken!
  }

  async tryRefresh(): Promise<string | null> {
    let refreshedToken: string | null = null
    if (this.refreshAuth) {
      try {
        refreshedToken = await this.refreshAuth()
      } catch (refreshErr) {
        console.warn('[reencryptAllItems] Token refresh callback failed:', refreshErr)
      }
    }
    if (!refreshedToken) {
      refreshedToken = await this.getAuth()
    }

    if (refreshedToken && refreshedToken !== this.currentToken) {
      console.info('[reencryptAllItems] Acquired fresh auth token, retrying batch upload...')
      this.currentToken = refreshedToken
      return refreshedToken
    }
    return null
  }

  getToken(): string {
    if (!this.currentToken) {
      throw new Error('No active session token available')
    }
    return this.currentToken
  }
}

export interface ReencryptDeps {
  accountId: string
  repo: Repo
  indexManager: AutomergeIndexManager
  getAuthToken?: () => Promise<string | null>
  refreshAuthToken?: () => Promise<string | null>
  scheduleRetry?: (delayMs?: number) => void
}

export interface ReencryptResult {
  succeeded: ItemId[]
  failed: Array<{ itemId: ItemId; error: string }>
}

export async function reencryptAllItems(
  deps: ReencryptDeps,
  onProgress?: (done: number, total: number) => void
): Promise<ReencryptResult> {
  if (!deps?.accountId || !deps?.repo || !deps?.indexManager) {
    throw new Error('SyncWorker not initialized')
  }

  const { accountId, repo, indexManager } = deps
  const authManager = new ReencryptAuthManager(deps)
  await authManager.getInitialToken()

  const allItemIds = await indexManager.listAutomergeItemIds()
  const total = allItemIds.length
  if (total === 0) {
    if (onProgress) {
      onProgress(0, 0)
    }
    scheduledRetryAttempt = 0
    return { succeeded: [], failed: [] }
  }

  let processed = 0
  const succeeded: ItemId[] = []
  const failed: Array<{ itemId: ItemId; error: string }> = []

  const handleSnapshotFailure = async (
    itemId: ItemId,
    errorMsg: string,
    rawError?: unknown
  ): Promise<void> => {
    if (rawError !== undefined) {
      console.error(`[reencryptAllItems] ${errorMsg}`, rawError)
    } else {
      console.error(`[reencryptAllItems] ${errorMsg}`)
    }
    failed.push({ itemId, error: errorMsg })
    await quarantineItem(
      accountId,
      itemId,
      `Re-encryption snapshot build failed: ${errorMsg}`
    )
  }

  const itemChunks = chunk(allItemIds, 10)

  for (const chunkIds of itemChunks) {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      const errMsg = 'Network is offline'
      console.warn(`[reencryptAllItems] Aborting: ${errMsg}`)
      scheduleReencryptRetry(deps, onProgress)
      throw new Error(`Re-encryption aborted: network error (${errMsg})`)
    }

    await authManager.syncLatestToken()

    const snapshotPromises = chunkIds.map(async itemId => {
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
    })
    const settled = await Promise.allSettled(snapshotPromises)

    const readySnapshots: Array<{ itemId: ItemId; snapshot: VaultSnapshotInput }> = []
    for (const [index, result] of settled.entries()) {
      const itemId = chunkIds[index]
      if (result.status === 'fulfilled') {
        if (result.value.type === 'success') {
          readySnapshots.push({ itemId, snapshot: result.value.snapshot })
        } else if (result.value.type === 'not-ready') {
          console.warn(`[reencryptAllItems] Item ${itemId} was not ready. Skipping.`)
        } else if (result.value.type === 'error') {
          const errMsg = result.value.reason
            ? `Failed to build snapshot for item ${itemId}: ${result.value.reason}`
            : `Failed to build snapshot for item ${itemId}`
          await handleSnapshotFailure(itemId, errMsg)
        }
      } else {
        const errorDetail =
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        await handleSnapshotFailure(
          itemId,
          `Failed to build snapshot for item ${itemId}: ${errorDetail}`,
          result.reason
        )
      }
    }

    if (readySnapshots.length > 0) {
      let uploadSuccess = false
      let lastError: unknown = null

      for (let attempt = 1; attempt <= MAX_BATCH_RETRIES; attempt++) {
        try {
          const response = await putSnapshotsWithToken({
            account: accountId,
            authToken: authManager.getToken(),
            snapshots: readySnapshots.map(r => r.snapshot),
          })

          if (response?.success && (response.persisted === undefined || response.persisted === readySnapshots.length)) {
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
            const refreshed = await authManager.tryRefresh()
            if (refreshed) {
              continue
            }

            // Auth error cannot be resolved; abort immediately without quarantining items!
            throw toAuthExpiredError(err)
          }

          if (isNetworkError(err) || isServerError(err)) {
            if (typeof navigator !== 'undefined' && !navigator.onLine) {
              break
            }
          }
        }
      }

      if (uploadSuccess) {
        for (const item of readySnapshots) {
          succeeded.push(item.itemId)
        }
      } else {
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

        const errMsg =
          `Failed to upload snapshots for batch after ${MAX_BATCH_RETRIES} attempts` +
          (lastError instanceof Error ? `: ${lastError.message}` : '')
        console.error(`[reencryptAllItems] ${errMsg}`)
        for (const item of readySnapshots) {
          failed.push({ itemId: item.itemId, error: errMsg })
          await quarantineItem(
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

  scheduledRetryAttempt = 0
  return { succeeded, failed }
}
