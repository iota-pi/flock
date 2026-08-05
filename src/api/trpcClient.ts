import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../vault/trpc/root'
import env from '../env'
import { getApiAuthToken } from './runtime'

let trpcClient: ReturnType<typeof createTRPCProxyClient<AppRouter>>

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

export function initTrpcClient(customFetch: typeof fetch) {
  trpcClient = createTRPCProxyClient<AppRouter>({
    links: getTrpcLinks(customFetch),
  })
}

export function getTrpcClient() {
  if (!trpcClient) {
    throw new Error('trpcClient not initialized. Please call initTrpcClient with a fetch implementation before using the client.')
  }
  return trpcClient
}
