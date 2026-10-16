import { createTRPCProxyClient, httpBatchLink, type TRPCLink } from '@trpc/client'
import { observable } from '@trpc/server/observable'
import type { VaultRouter } from '@vault/server'
import { isClientOutdatedError, PROTOCOL_VERSION_HEADER, VAULT_PROTOCOL_VERSION } from '@vault/shared'
import { getApiAuthToken } from './runtime'
import { broadcastVaultEvent } from './util'

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

/** Announces errors that say this build is too old, so the host app can update (see `onClientOutdated`) */
function clientOutdatedLink(): TRPCLink<VaultRouter> {
  return () => ({ next, op }) => observable(observer => next(op).subscribe({
    next: value => observer.next(value),
    error: error => {
      if (isClientOutdatedError(error)) {
        broadcastVaultEvent({ type: 'CLIENT_OUTDATED' })
      }
      observer.error(error)
    },
    complete: () => observer.complete(),
  }))
}

/**
 * Links for a tRPC client of the vault's server, including app routers built on the same tRPC
 * instance. They send the session token (`authToken`, or else the realm's current one) and this
 * build's protocol version, and report when the server says the build is too old.
 */
export function createVaultLinks(
  { url = getVaultTrpcUrl(), customFetch, authToken }: {
    url?: string,
    customFetch?: typeof fetch,
    authToken?: string,
  } = {},
): TRPCLink<VaultRouter>[] {
  return [
    clientOutdatedLink(),
    httpBatchLink({
      url,
      headers: () => {
        const token = authToken ?? getApiAuthToken()
        return {
          [PROTOCOL_VERSION_HEADER]: String(VAULT_PROTOCOL_VERSION),
          ...(token ? { Authorization: `Basic ${token}` } : {}),
        }
      },
      fetch: customFetch,
    }),
  ]
}

export function initVaultTrpcClient(customFetch: typeof fetch) {
  vaultTrpcClient = createTRPCProxyClient<VaultRouter>({
    links: createVaultLinks({ customFetch }),
  })
}

export function getVaultTrpcClient() {
  if (!vaultTrpcClient) {
    throw new Error('Vault tRPC client not initialized. Call initVaultTrpcClient with a fetch implementation first.')
  }
  return vaultTrpcClient
}
