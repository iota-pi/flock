import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../vault/trpc/root'
import env from '../env'
import { getApiAuthToken, trackedFetch } from './runtime'

export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${env.VAULT_ENDPOINT}/trpc`,
      headers: () => {
        const token = getApiAuthToken()
        return token ? { Authorization: `Basic ${token}` } : {}
      },
      fetch: trackedFetch,
    }),
  ],
})