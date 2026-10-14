import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { VaultRouter } from '../vault/trpc/vaultRouter'
import { getApiAuthToken } from './runtime'

let vaultEndpoint = ''
let vaultTrpcClient: ReturnType<typeof createTRPCProxyClient<VaultRouter>> | null = null

/**
 * Sets the vault API base URL (the tRPC handler is served at `${endpoint}/trpc`).
 * Each realm (main thread and sync worker) must configure it before making requests.
 */
export function configureVaultEndpoint(endpoint: string) {
  vaultEndpoint = endpoint.replace(/\/$/, '')
}

export function getVaultTrpcUrl() {
  return `${vaultEndpoint}/trpc`
}

export function initVaultTrpcClient(customFetch: typeof fetch) {
  vaultTrpcClient = createTRPCProxyClient<VaultRouter>({
    links: [
      httpBatchLink({
        url: getVaultTrpcUrl(),
        headers: () => {
          const token = getApiAuthToken()
          return token ? { Authorization: `Basic ${token}` } : {}
        },
        fetch: customFetch,
      }),
    ],
  })
}

export function getVaultTrpcClient() {
  if (!vaultTrpcClient) {
    throw new Error('Vault tRPC client not initialized. Call initVaultTrpcClient with a fetch implementation first.')
  }
  return vaultTrpcClient
}
