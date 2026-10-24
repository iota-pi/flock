import type { z } from 'zod'
import { getApiAuthToken } from '../../api/runtime'
import { classifySyncError } from './utils/errorClassifier'
import {
  putSnapshots,
  pollSyncBatch,
  type PollSyncBatchResponse,
} from '../../api/SyncWorkerClient'
import { fetchManifest, fetchSnapshotsByIds } from '../../api/ItemClient'
import { raiseDataVersion } from '../../api/AccountClient'
import type {
  VaultSnapshotInput,
  ItemId,
  ManifestEntry,
  SyncPollBatchSchema,
  PutSnapshotResultItem,
} from '@vault/shared'
import type { VaultItem } from '../../api/clientTypes'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncApiClient')

export class AuthError extends Error {
  readonly code = 'UNAUTHORIZED' as const
  constructor(message = 'No active session token available', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthError'
  }
}

export class AuthExpiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AuthExpiredError'
  }
}

export function toAuthExpiredError(err: unknown): AuthExpiredError {
  if (err instanceof AuthExpiredError) {
    return err
  }
  const message = err instanceof Error
    ? err.message
    : typeof (err as { message?: unknown })?.message === 'string'
      ? (err as { message: string }).message
      : String(err)
  return new AuthExpiredError(
    `Authentication session expired (${message})`,
    { cause: err }
  )
}

export interface SyncApiClientOptions {
  /**
   * Gets a new session token and makes it the realm's (`setApiAuthToken`), resolving with it, or
   * with null if there is none. Concurrent calls must share one refresh.
   */
  refreshAuthToken?: () => Promise<string | null>
}

/**
 * Sends the sync worker's requests with the realm's session token (`getApiAuthToken`), getting a
 * new one when there is none or the server rejects it.
 */
export class SyncApiClient {
  private readonly refreshAuth?: () => Promise<string | null>

  constructor(options: SyncApiClientOptions = {}) {
    this.refreshAuth = options.refreshAuthToken
  }

  /** The realm's session token, refreshed if it has none. Null when no token is available. */
  async getValidToken(): Promise<string | null> {
    return getApiAuthToken() || this.refreshToken()
  }

  /**
   * Gets a new session token. If the refresh fails, returns whichever token the realm holds by
   * then, since one may have arrived in the meantime.
   */
  private async refreshToken(): Promise<string | null> {
    let refreshed: string | null = null
    if (this.refreshAuth) {
      try {
        refreshed = await this.refreshAuth()
      } catch (refreshErr) {
        log.warn('Token refresh callback failed:', refreshErr)
      }
    }
    return refreshed || getApiAuthToken() || null
  }

  /**
   * Executes an operation with an authenticated session token.
   * If the operation fails with an auth error (401/403/UNAUTHORIZED),
   * transparently refreshes the token and retries the operation once.
   */
  async executeWithAuth<T>(operation: () => Promise<T>): Promise<T> {
    const token = await this.getValidToken()
    if (!token) {
      throw new AuthError('No active session token available')
    }

    try {
      return await operation()
    } catch (err) {
      if (!classifySyncError(err).isAuth) {
        throw err
      }

      log.warn('Auth error detected; attempting transparent token refresh and retry...', err)
      const refreshedToken = await this.refreshToken()
      if (!refreshedToken || refreshedToken === token) {
        throw toAuthExpiredError(err)
      }

      try {
        return await operation()
      } catch (retryErr) {
        if (classifySyncError(retryErr).isAuth) {
          throw toAuthExpiredError(retryErr)
        }
        throw retryErr
      }
    }
  }

  async putSnapshots(
    input: {
      account: string
      snapshots: VaultSnapshotInput[]
    },
    options?: { signal?: AbortSignal }
  ): Promise<{ success: boolean; persisted: number; total?: number; results?: PutSnapshotResultItem[] }> {
    return this.executeWithAuth(() => putSnapshots(input, options))
  }

  async raiseDataVersion(input: { account: string }): Promise<{ dataVersion: number, blockers: string[] }> {
    return this.executeWithAuth(() => raiseDataVersion(input.account))
  }

  async fetchManifest(
    input: { account: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ manifest: ManifestEntry[]; serverTime: number }> {
    return this.executeWithAuth(() => fetchManifest({ account: input.account }, options))
  }

  async fetchSnapshotsByIds(
    input: {
      account: string
      itemIds: ItemId[]
    },
    options?: { signal?: AbortSignal }
  ): Promise<{ items: VaultItem[]; serverTime: number }> {
    return this.executeWithAuth(() => fetchSnapshotsByIds(
      { account: input.account, itemIds: input.itemIds },
      options,
    ))
  }

  async pollSyncBatch(
    input: z.infer<typeof SyncPollBatchSchema>,
    options?: { signal?: AbortSignal }
  ): Promise<PollSyncBatchResponse> {
    return this.executeWithAuth(() => pollSyncBatch(input, options))
  }
}
