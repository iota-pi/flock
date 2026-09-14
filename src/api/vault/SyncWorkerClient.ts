import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../vault/trpc/root'
import env from '../../env'
import type { VaultSnapshotInput } from 'src/shared/schemas/snapshots'
import type { ItemId } from 'src/shared/schemas/items'
import type { z } from 'zod'
import type { SyncPollBatchSchema } from 'src/shared/schemas/trpc'
type SyncMessageEnvelope = {
  iv: string
  cipher: string
  version?: string
  kver?: string
}

let cachedClient: { authToken: string; client: ReturnType<typeof createTRPCProxyClient<AppRouter>> } | null = null

function createWorkerSyncClient(authToken: string) {
  if (cachedClient && cachedClient.authToken === authToken) {
    return cachedClient.client
  }

  const client = createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${env.VAULT_ENDPOINT}/trpc`,
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
  lastEvaluatedKey?: Record<string, unknown>
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
  globalLastEvaluatedKey?: Record<string, unknown>
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
): Promise<{ success: boolean; persisted: number; total: number }> {
  const client = createWorkerSyncClient(input.authToken)
  return client.items.putSnapshots.mutate(
    {
      account: input.account,
      snapshots: input.snapshots,
    },
    options?.signal ? { signal: options.signal } : undefined
  )
}

