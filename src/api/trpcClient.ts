import { createTRPCProxyClient } from '@trpc/client'
import type { AppRouter } from '../vault/trpc/root'
import env from '../env'
import { createVaultLinks } from '@vault/client/trpc'

export type AppTrpcClient = ReturnType<typeof createTRPCProxyClient<AppRouter>>

let trpcClient: AppTrpcClient

export function createTrpcClient(customFetch?: typeof fetch): AppTrpcClient {
  return createTRPCProxyClient<AppRouter>({
    links: createVaultLinks({ url: `${env.VAULT_ENDPOINT}/trpc`, customFetch }),
  })
}

export function initTrpcClient(customFetch: typeof fetch) {
  trpcClient = createTrpcClient(customFetch)
}

export function getTrpcClient() {
  if (!trpcClient) {
    throw new Error('trpcClient not initialized. Please call initTrpcClient with a fetch implementation before using the client.')
  }
  return trpcClient
}
