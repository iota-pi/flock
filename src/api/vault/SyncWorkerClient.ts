import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../vault/trpc/root'
import env from '../../env'

type SyncMessageEnvelope = {
  iv: string
  cipher: string
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

export async function pushSyncBatchWithToken(input: {
  account: string
  authToken: string
  messages: Array<{
    itemId: string
    encryptedMessage: SyncMessageEnvelope
  }>
}): Promise<{ success: true; results: Array<{ itemId: string; cursor: number }> }> {
  const client = createWorkerSyncClient(input.authToken)
  return client.sync.pushBatch.mutate({
    account: input.account,
    messages: input.messages,
  })
}

export type PullSyncMessagesResponse = {
  success: boolean
  itemId: string
  nextCursor: number
  messages: Array<{
    cursor: number
    encryptedMessage: SyncMessageEnvelope
  }>
}


export async function pollSyncBatchWithToken(input: {
  account: string
  authToken: string
  pushMessages: Array<{
    itemId: string
    encryptedMessage: SyncMessageEnvelope
  }>
  pullCursors: Array<{
    itemId: string
    cursor?: number
  }>
}) {
  const client = createWorkerSyncClient(input.authToken)
  return client.sync.pollSync.mutate({
    account: input.account,
    pushMessages: input.pushMessages,
    pullCursors: input.pullCursors,
  })
}
