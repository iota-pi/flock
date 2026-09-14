import type { z } from 'zod'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import * as runtime from '../../api/runtime'
import { isAuthError } from './utils/auth'
import {
  putSnapshotsWithToken,
  pollSyncBatchWithToken,
  type PollSyncBatchResponse,
} from '../../api/vault/SyncWorkerClient'
import { fetchManifest, fetchSnapshotsByIds } from '../../api/vault/ItemClient'
import { getTrpcClient } from 'src/api/trpcClient'
import type { VaultSnapshotInput } from 'src/shared/schemas/snapshots'
import type { ItemId } from 'src/shared/schemas/items'
import type { VaultItem } from '../../api/vault/clientTypes'
import type { AccountMetadata } from '../../state/metadata'
import type { SyncPollBatchSchema } from 'src/shared/schemas/trpc'
import type { ManifestEntry } from './ManifestSyncManager'

function safeSetApiAuthToken(token: string) {
  try {
    runtime.setApiAuthToken?.(token)
  } catch {
    // Ignore
  }
}

function safeHasApiAuthToken(): boolean {
  try {
    return !!runtime.hasApiAuthToken?.()
  } catch {
    return false
  }
}

function safeGetApiAuthToken(): string {
  try {
    return runtime.getApiAuthToken?.() || ''
  } catch {
    return ''
  }
}

export class AuthExpiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthExpiredError'
  }
}

export function toAuthExpiredError(err: unknown): AuthExpiredError {
  const message = err instanceof Error ? err.message : String(err)
  return new AuthExpiredError(
    `Re-encryption aborted: authentication session expired (${message})`,
    { cause: err }
  )
}

export interface SyncApiClientOptions {
  getAuthToken?: () => Promise<string | null>
  refreshAuthToken?: () => Promise<string | null>
}

export class SyncApiClient {
  private currentToken: string | null = null
  private refreshPromise: Promise<string | null> | null = null
  private readonly getAuth: () => Promise<string | null>
  private readonly refreshAuth?: () => Promise<string | null>

  constructor(options: SyncApiClientOptions = {}) {
    this.getAuth = options.getAuthToken ?? getActiveSessionToken
    this.refreshAuth = options.refreshAuthToken
  }

  /**
   * Retrieves a valid authentication token.
   * Checks persistence store, then runtime token, then cached in-memory token,
   * falling back to refreshAuthToken if needed.
   */
  async getValidToken(): Promise<string | null> {
    if (this.currentToken) {
      return this.currentToken
    }

    try {
      const latest = await this.getAuth()
      if (latest) {
        this.currentToken = latest
        safeSetApiAuthToken(latest)
        return latest
      } else {
        this.currentToken = null
        safeSetApiAuthToken('')
      }
    } catch {
      // Fall through on store read error
    }

    if (this.refreshAuth) {
      const refreshed = await this.refreshToken()
      if (refreshed) return refreshed
    }

    if (safeHasApiAuthToken()) {
      const runtimeToken = safeGetApiAuthToken()
      if (runtimeToken) {
        this.currentToken = runtimeToken
        return runtimeToken
      }
      return 'active-token'
    }

    return null
  }

  /**
   * Synchronizes latest token from store without forcing a refresh.
   */
  async syncLatestToken(): Promise<string | null> {
    try {
      const latest = await this.getAuth()
      if (latest) {
        this.currentToken = latest
        safeSetApiAuthToken(latest)
        return latest
      }
    } catch {
      // Ignore
    }
    return this.currentToken
  }

  /**
   * Coalesced (single-flight) token refresh to prevent multiple concurrent refreshes.
   */
  async refreshToken(): Promise<string | null> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = (async () => {
      try {
        let refreshed: string | null = null
        if (this.refreshAuth) {
          try {
            refreshed = await this.refreshAuth()
          } catch (refreshErr) {
            console.warn('[SyncApiClient] Token refresh callback failed:', refreshErr)
          }
        }
        if (!refreshed) {
          try {
            refreshed = await this.getAuth()
          } catch {
            // Ignore
          }
        }
        if (refreshed) {
          this.currentToken = refreshed
          safeSetApiAuthToken(refreshed)
          console.info('[SyncApiClient] Acquired fresh auth token')
        }
        return refreshed
      } finally {
        this.refreshPromise = null
      }
    })()

    return this.refreshPromise
  }

  async hasAuthToken(): Promise<boolean> {
    const latest = await this.getAuth().catch(() => null)
    if (latest) {
      this.currentToken = latest
      safeSetApiAuthToken(latest)
      return true
    } else {
      this.currentToken = null
      safeSetApiAuthToken('')
    }
    if (this.refreshAuth) {
      const token = await this.getValidToken()
      return !!token
    }
    if (safeHasApiAuthToken()) {
      return true
    }
    return false
  }

  getToken(): string {
    if (!this.currentToken) {
      throw new Error('No active session token available')
    }
    return this.currentToken
  }

  /**
   * Executes an operation with an authenticated session token.
   * If the operation fails with an auth error (401/403/UNAUTHORIZED),
   * transparently refreshes the token and retries the operation once.
   */
  async executeWithAuth<T>(operation: (authToken: string) => Promise<T>): Promise<T> {
    const token = await this.getValidToken()
    if (!token) {
      throw new Error('No active session token available')
    }

    try {
      return await operation(token)
    } catch (err) {
      if (!isAuthError(err)) {
        throw err
      }

      console.warn('[SyncApiClient] Auth error detected; attempting transparent token refresh and retry...', err)
      const refreshedToken = await this.refreshToken()
      if (!refreshedToken || refreshedToken === token) {
        throw toAuthExpiredError(err)
      }

      try {
        return await operation(refreshedToken)
      } catch (retryErr) {
        if (isAuthError(retryErr)) {
          throw toAuthExpiredError(retryErr)
        }
        throw retryErr
      }
    }
  }

  async putSnapshots(input: {
    account: string
    snapshots: VaultSnapshotInput[]
  }): Promise<{ success: boolean; persisted: number; total?: number }> {
    return this.executeWithAuth(async authToken => {
      safeSetApiAuthToken(authToken)
      return putSnapshotsWithToken({
        account: input.account,
        authToken,
        snapshots: input.snapshots,
      })
    })
  }

  async fetchManifest(input: {
    account: string
  }): Promise<{ manifest: ManifestEntry[]; serverTime: number }> {
    return this.executeWithAuth(async authToken => {
      safeSetApiAuthToken(authToken)
      return fetchManifest({ account: input.account })
    })
  }

  async fetchSnapshotsByIds(input: {
    account: string
    itemIds: ItemId[]
  }): Promise<{ items: VaultItem[]; serverTime: number }> {
    return this.executeWithAuth(async authToken => {
      safeSetApiAuthToken(authToken)
      return fetchSnapshotsByIds({ account: input.account, itemIds: input.itemIds })
    })
  }

  async getAccountMetadata(input: {
    account: string
  }): Promise<AccountMetadata | null> {
    return this.executeWithAuth(async authToken => {
      safeSetApiAuthToken(authToken)
      const response = await getTrpcClient().accounts.getMetadata.query({
        account: input.account,
      })
      if (
        response?.success &&
        response.metadata &&
        typeof response.metadata === 'object' &&
        !Array.isArray(response.metadata)
      ) {
        return response.metadata as AccountMetadata
      }
      return null
    })
  }

  async updateAccountMetadata(input: {
    account: string
    metadata: AccountMetadata
  }): Promise<void> {
    return this.executeWithAuth(async authToken => {
      safeSetApiAuthToken(authToken)
      await getTrpcClient().accounts.updateMetadata.mutate({
        account: input.account,
        metadata: input.metadata,
      })
    })
  }

  async pollSyncBatch(
    input: z.infer<typeof SyncPollBatchSchema>,
    options?: { signal?: AbortSignal }
  ): Promise<PollSyncBatchResponse> {
    return this.executeWithAuth(async authToken => {
      safeSetApiAuthToken(authToken)
      return pollSyncBatchWithToken({ ...input, authToken }, options)
    })
  }
}
