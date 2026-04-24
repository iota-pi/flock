import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../vault/trpc/root'
import env from '../../env'

type SyncMessageEnvelope = {
  iv: string
  cipher: string
}

function createWorkerSyncClient(authToken: string) {
  return createTRPCProxyClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${env.VAULT_ENDPOINT}/trpc`,
        headers: {
          Authorization: `Basic ${authToken}`,
        },
      }),
    ],
  })
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
