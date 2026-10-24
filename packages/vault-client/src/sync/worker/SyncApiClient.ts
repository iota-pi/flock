import type { z } from 'zod'
import { getActiveSessionToken } from '../shared/workerAuthStore'
import { getApiAuthToken, setApiAuthToken } from '../../api/runtime'
import { classifySyncError } from './utils/errorClassifier'
import {
  putSnapshotsWithToken,
  pollSyncBatchWithToken,
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
   * Sets the active authentication token in memory and runtime.
   */
  setToken(token: string | null): void {
    this.currentToken = token
    setApiAuthToken(token || '')
  }

  /**
   * Retrieves a valid authentication token: the cached one, then the realm's in-memory session token
   * (`getActiveSessionToken`), then refreshAuthToken, then the runtime token.
   */
  async getValidToken(): Promise<string | null> {
    if (this.currentToken) {
      return this.currentToken
    }

    try {
      const latest = await this.getAuth()
      if (latest) {
        this.currentToken = latest
        setApiAuthToken(latest)
        return latest
      } else {
        this.currentToken = null
        setApiAuthToken('')
      }
    } catch {
      // Fall through on store read error
    }

    if (this.refreshAuth) {
      const refreshed = await this.refreshToken()
      if (refreshed) return refreshed
    }

    const runtimeToken = getApiAuthToken()
    if (runtimeToken) {
      this.currentToken = runtimeToken
      return runtimeToken
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
        setApiAuthToken(latest)
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
            log.warn('Token refresh callback failed:', refreshErr)
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
          setApiAuthToken(refreshed)
          log.info('Acquired fresh auth token')
        }
        return refreshed
      } finally {
        this.refreshPromise = null
      }
    })()

    return this.refreshPromise
  }

  /**
   * Executes an operation with an authenticated session token.
   * If the operation fails with an auth error (401/403/UNAUTHORIZED),
   * transparently refreshes the token and retries the operation once.
   */
  async executeWithAuth<T>(operation: (authToken: string) => Promise<T>): Promise<T> {
    const token = await this.getValidToken()
    if (!token) {
      throw new AuthError('No active session token available')
    }

    setApiAuthToken(token)

    try {
      return await operation(token)
    } catch (err) {
      if (!classifySyncError(err).isAuth) {
        throw err
      }

      log.warn('Auth error detected; attempting transparent token refresh and retry...', err)
      const refreshedToken = await this.refreshToken()
      if (!refreshedToken || refreshedToken === token) {
        throw toAuthExpiredError(err)
      }

      setApiAuthToken(refreshedToken)

      try {
        return await operation(refreshedToken)
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
    return this.executeWithAuth(async authToken => {
      return putSnapshotsWithToken(
        {
          account: input.account,
          authToken,
          snapshots: input.snapshots,
        },
        ...(options ? [options] : []),
      )
    })
  }

  async raiseDataVersion(input: { account: string }): Promise<{ dataVersion: number, blockers: string[] }> {
    return this.executeWithAuth(() => raiseDataVersion(input.account))
  }

  async fetchManifest(
    input: { account: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ manifest: ManifestEntry[]; serverTime: number }> {
    return this.executeWithAuth(async () => {
      return fetchManifest(
        { account: input.account },
        ...(options ? [options] : []),
      )
    })
  }

  async fetchSnapshotsByIds(
    input: {
      account: string
      itemIds: ItemId[]
    },
    options?: { signal?: AbortSignal }
  ): Promise<{ items: VaultItem[]; serverTime: number }> {
    return this.executeWithAuth(async () => {
      return fetchSnapshotsByIds(
        { account: input.account, itemIds: input.itemIds },
        ...(options ? [options] : []),
      )
    })
  }

  async pollSyncBatch(
    input: z.infer<typeof SyncPollBatchSchema>,
    options?: { signal?: AbortSignal }
  ): Promise<PollSyncBatchResponse> {
    return this.executeWithAuth(async authToken => {
      return pollSyncBatchWithToken({ ...input, authToken }, options)
    })
  }
}
