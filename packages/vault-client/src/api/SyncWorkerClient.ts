import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { VaultRouter } from '@vault/server'
import { getVaultTrpcUrl } from './vaultTrpcClient'
import type { VaultSnapshotInput, ItemId , DOC_BOUND_FORMAT ,
  SyncPollBatchSchema,
  PageToken,
  PutSnapshotResultItem } from '@vault/shared'
import type { z } from 'zod'
type SyncMessageEnvelope = {
  iv: string
  cipher: string
  version?: string
  kver?: string
  format?: typeof DOC_BOUND_FORMAT
}

let cachedClient: { authToken: string; client: ReturnType<typeof createTRPCProxyClient<VaultRouter>> } | null = null

function createWorkerSyncClient(authToken: string) {
  if (cachedClient && cachedClient.authToken === authToken) {
    return cachedClient.client
  }

  const client = createTRPCProxyClient<VaultRouter>({
    links: [
      httpBatchLink({
        url: getVaultTrpcUrl(),
        headers: {
          Authorization: `Basic ${authToken}`,
        },
      }),
    ],
  })

  cachedClient = { authToken, client }
  return client
}

export type PullSyncMessagesResponse = {
  success?: boolean
  itemId: ItemId
  cursor?: number
  nextCursor?: number
  messages: Array<{
    cursor: number
    encryptedMessage: SyncMessageEnvelope
  }>
  hasMore: boolean
  nextPageToken?: PageToken
}

export type PushResultItem = {
  itemId: ItemId
  cursor?: number
  success?: boolean
  error?: string
}

export type PollSyncBatchResponse = {
  success: boolean
  pushResults: Array<PushResultItem>
  pullResults: Array<PullSyncMessagesResponse>
  hasMore?: boolean
  globalNextPageToken?: PageToken
  // Whether the account-wide scan has more pages
  globalHasMore?: boolean
  // Highest cursor examined by the account-wide scan
  globalScannedThroughCursor?: number
}


export async function pollSyncBatchWithToken(
  input: z.infer<typeof SyncPollBatchSchema> & { authToken: string },
  options?: { signal?: AbortSignal }
): Promise<PollSyncBatchResponse> {
  const client = createWorkerSyncClient(input.authToken)
  const { authToken, ...rpcInput } = input
  return client.sync.pollSync.mutate(rpcInput, options?.signal ? { signal: options.signal } : undefined)
}

export async function putSnapshotsWithToken(
  input: {
    account: string
    authToken: string
    snapshots: VaultSnapshotInput[]
  },
  options?: { signal?: AbortSignal }
): Promise<{ success: boolean; persisted: number; total: number; results?: PutSnapshotResultItem[] }> {
  const client = createWorkerSyncClient(input.authToken)
  return client.items.putSnapshots.mutate(
    {
      account: input.account,
      snapshots: input.snapshots,
    },
    options?.signal ? { signal: options.signal } : undefined
  )
}

