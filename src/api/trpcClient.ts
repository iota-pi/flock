import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../vault/trpc/root'
import env from '../env'
import { getApiAuthToken } from './runtime'

export type AppTrpcClient = ReturnType<typeof createTRPCProxyClient<AppRouter>>

let trpcClient: AppTrpcClient

function getTrpcLinks(customFetch?: typeof fetch) {
  return [
    httpBatchLink({
      url: `${env.VAULT_ENDPOINT}/trpc`,
      headers: () => {
        const token = getApiAuthToken()
        return token ? { Authorization: `Basic ${token}` } : {}
      },
      fetch: customFetch,
    }),
  ]
}

export function createTrpcClient(customFetch?: typeof fetch): AppTrpcClient {
  return createTRPCProxyClient<AppRouter>({
    links: getTrpcLinks(customFetch),
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
