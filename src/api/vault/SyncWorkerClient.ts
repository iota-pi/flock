import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../vault/trpc/root'
import env from '../../env'
import type { VaultSnapshotInput } from 'src/shared/schemas/snapshots'
import type { ItemId } from 'src/shared/schemas/items'

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
  success: boolean
  itemId: ItemId
  nextCursor: number
  messages: Array<{
    cursor: number
    encryptedMessage: SyncMessageEnvelope
  }>
  hasMore: boolean
}

export type PollSyncBatchResponse = {
  success: boolean
  pushResults: Array<{ itemId: ItemId; cursor: number }>
  pullResults: Array<{
    success: true
    itemId: ItemId
    nextCursor: number
    messages: Array<{
      cursor: number
      encryptedMessage: SyncMessageEnvelope
    }>
    hasMore: boolean
  }>
  snapshotRequest?: {
    requested: true
    cursor: number
    requestedAt: number
  }
}


export async function pollSyncBatchWithToken(input: {
  account: string
  authToken: string
  pushMessages: Array<{
    itemId: ItemId
    encryptedMessage: SyncMessageEnvelope
  }>
  pullCursors: Array<{
    itemId: ItemId
    cursor?: number
  }>
}): Promise<PollSyncBatchResponse> {
  const client = createWorkerSyncClient(input.authToken)
  return client.sync.pollSync.mutate({
    account: input.account,
    pushMessages: input.pushMessages,
    pullCursors: input.pullCursors,
  })
}

export async function putSnapshotsWithToken(input: {
  account: string
  authToken: string
  snapshots: VaultSnapshotInput[]
}): Promise<{ success: boolean; persisted: number; total: number }> {
  const client = createWorkerSyncClient(input.authToken)
  return client.items.putSnapshots.mutate({
    account: input.account,
    snapshots: input.snapshots,
  })
}

export async function fetchMetadataWithToken(input: {
  account: string
  authToken: string
}): Promise<{ success: boolean; items: Array<{ itemId: ItemId; modified: number; deleted: boolean; type: string }>; serverTime: number }> {
  const client = createWorkerSyncClient(input.authToken)
  return client.items.fetchMetadata.query({
    account: input.account,
  })
}
