import type { z } from 'zod'
import type { inferRouterOutputs } from '@trpc/server'
import type { VaultRouter } from '@vault/server'
import {
  FetchItemsInputSchema,
  FetchSnapshotsByIdsInputSchema,
  type FetchedItem,
  type VaultSnapshotInput,
  type ItemId,
  type ManifestEntry,
  type SyncPollBatchSchema,
} from '@vault/shared'
import { getApiAuthToken } from '../../api/runtime'
import { assertSuccess } from '../../api/clientUtils'
import { getUntrackedVaultTrpcClient, getVaultTrpcClient } from '../../api/vaultTrpcClient'
import { raiseDataVersion } from '../../api/AccountClient'
import { classifySyncError } from '../utils/errorClassifier'
import { errorMessage } from '../utils/errorMessage'
import { createLogger } from '../utils/logger'

type VaultOutputs = inferRouterOutputs<VaultRouter>

export type PollSyncBatchResponse = VaultOutputs['sync']['pollSync']
export type PullSyncMessagesResponse = PollSyncBatchResponse['pullResults'][number]
export type PushResultItem = PollSyncBatchResponse['pushResults'][number]
export type PutSnapshotsResponse = VaultOutputs['items']['putSnapshots']

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
  // tRPC errors can arrive as plain objects, so take a string message from those too
  const objectMessage = (err as { message?: unknown } | null | undefined)?.message
  const message = !(err instanceof Error) && typeof objectMessage === 'string'
    ? objectMessage
    : errorMessage(err)
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
  ): Promise<PutSnapshotsResponse> {
    return this.executeWithAuth(() => getUntrackedVaultTrpcClient().items.putSnapshots.mutate(
      { account: input.account, snapshots: input.snapshots },
      options,
    ))
  }

  async raiseDataVersion(input: { account: string }): Promise<{ dataVersion: number, blockers: string[] }> {
    return this.executeWithAuth(() => raiseDataVersion(input.account))
  }

  async fetchManifest(
    input: { account: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ manifest: ManifestEntry[]; serverTime: number }> {
    return this.executeWithAuth(async () => {
      const parsed = FetchItemsInputSchema.parse({ account: input.account })
      const data = await getVaultTrpcClient().items.fetchManifest.query(parsed, options)
      assertSuccess(data, 'fetchManifest')
      return { manifest: data.manifest, serverTime: data.serverTime }
    })
  }

  async fetchSnapshotsByIds(
    input: {
      account: string
      itemIds: ItemId[]
    },
    options?: { signal?: AbortSignal }
  ): Promise<{ items: FetchedItem[]; serverTime: number }> {
    return this.executeWithAuth(async () => {
      const parsed = FetchSnapshotsByIdsInputSchema.parse({ account: input.account, itemIds: input.itemIds })
      const data = await getVaultTrpcClient().items.fetchSnapshotsByIds.query(parsed, options)
      assertSuccess(data, 'fetchSnapshotsByIds')
      return { items: data.items, serverTime: data.serverTime }
    })
  }

  async pollSyncBatch(
    input: z.infer<typeof SyncPollBatchSchema>,
    options?: { signal?: AbortSignal }
  ): Promise<PollSyncBatchResponse> {
    return this.executeWithAuth(() => getUntrackedVaultTrpcClient().sync.pollSync.mutate(input, options))
  }
}
