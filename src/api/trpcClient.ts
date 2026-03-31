import { createTRPCClient, createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../vault/trpc/root'
import env from '../env'
import { getApiAuthToken, trackedFetch } from './runtime'

function getTrpcLinks() {
  return [
    httpBatchLink({
      url: `${env.VAULT_ENDPOINT}/trpc`,
      headers: () => {
        const token = getApiAuthToken()
        return token ? { Authorization: `Basic ${token}` } : {}
      },
      fetch: trackedFetch,
    }),
  ]
}

export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: getTrpcLinks(),
})

export const trpcReactClient = createTRPCClient<AppRouter>({
  links: getTrpcLinks(),
})