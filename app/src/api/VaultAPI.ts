import type { AccountMetadata } from '../state/account'
import type { VaultItem, VaultKey, VaultSubscription, FlockPushSubscription } from '../../../shared/src/apiTypes'
import { getAccountId, flockRequestChunked, flockRequest } from './util'
import type { CryptoResult } from './Vault'

// Helper to check success flag and throw on failure
function assertSuccess(success: boolean | undefined, operation: string) {
  if (!success) {
    throw new Error(`VaultAPI ${operation} operation failed`)
  }
}

// Helper to validate response type
function assertValidType(value: unknown, expectedType: string, operation: string): void {
  if (typeof value !== expectedType) {
    throw new Error(`VaultAPI ${operation}: invalid ${expectedType} format`)
  }
}

// URL helpers to reduce repeated getAccountId() calls
function accountUrl(path = '') {
  return `/${getAccountId()}${path}`
}

function itemsUrl(itemId?: string) {
  return accountUrl(itemId ? `/items/${itemId}` : '/items')
}

function subscriptionUrl(subscriptionId: string) {
  return accountUrl(`/subscriptions/${subscriptionId}`)
}

export type CachedVaultItem = Partial<VaultItem> & VaultKey


export async function vaultFetchMany({
  cacheTime,
  ids,
}: {
  cacheTime?: number | null,
  ids?: string[],
}): Promise<VaultItem[]> {
  if (cacheTime !== undefined && ids) {
    throw new Error('Cannot use cacheTime and ids together')
  }
  const url = itemsUrl()
  if (cacheTime !== undefined) {
    let urlWithQuery = url
    if (cacheTime) {
      urlWithQuery = `${url}?since=${cacheTime}`
    }
    const result = await flockRequest(a => a.get(urlWithQuery))
    return result.data.items
  } else if (ids) {
    const result = await flockRequestChunked(
      {
        data: [ids],
        requestFactory: (
          a => batch => a.get(
            `${url}?ids=${batch.join(',')}`
          )
        ),
      },
    )
    return result.flatMap(r => r.data.items)
  } else {
    throw new Error('Must provide cacheTime or ids')
  }
}

export async function vaultFetch({ item }: VaultKey): Promise<VaultItem> {
  const url = itemsUrl(item)
  const result = await flockRequest(a => a.get(url))
  return result.data.items[0]
}

export async function vaultPut({ cipher, item, metadata }: VaultItem) {
  const url = itemsUrl(item)
  const result = await flockRequest(
    a => a.put(url, { cipher, ...metadata }),
  )
  assertSuccess(result.data.success, 'put')
}

export async function vaultPutMany({ items }: { items: VaultItem[] }) {
  const url = itemsUrl()
  const data = items.map(({ cipher, item, metadata }) => ({ cipher, id: item, ...metadata }))
  const result = await flockRequestChunked(
    {
      data,
      requestFactory: a => batch => a.put(url, batch),
    },
  )
  const success = result.filter(r => !r.data.success).length === 0
  assertSuccess(success, 'putMany')
}

export async function vaultDelete({ item }: VaultKey) {
  const url = itemsUrl(item)
  const result = await flockRequest(a => a.delete(url))
  assertSuccess(result.data.success, 'delete')
}

export async function vaultDeleteMany({ items }: & { items: string[] }) {
  const url = itemsUrl()
  const result = await flockRequestChunked(
    {
      data: items,
      requestFactory: a => batch => a.delete(url, { data: batch }),
    },
  )
  const success = result.filter(r => !r.data.success).length === 0
  assertSuccess(success, 'deleteMany')
}

type VaultCreateAccountResult = { account: string }
export async function vaultCreateAccount(
  { salt, authToken }: { salt: string; authToken: string },
): Promise<VaultCreateAccountResult> {
  const url = '/account'
  const result = await flockRequest({
    factory: a => a.post(url, { salt, authToken }),
    options: { allowNoInit: true },
  })
  const { account } = result.data satisfies VaultCreateAccountResult
  return { account }
}

export async function vaultGetSalt() {
  const url = accountUrl('/salt')
  const result = await flockRequest({
    factory: a => a.get(url),
    options: { allowNoInit: true },
  })
  assertSuccess(result.data.success && result.data.salt, 'getSalt')
  assertValidType(result.data.salt, 'string', 'getSalt')
  return result.data.salt as string
}

export async function vaultGetSession(authToken: string) {
  const url = accountUrl('/login')
  const result = await flockRequest({
    factory: a => a.post(url, { authToken }),
    options: { allowNoInit: true },
  })
  assertSuccess(result.data.success && result.data.session, 'getSession')
  assertValidType(result.data.session, 'string', 'getSession')
  return result.data.session as string
}

export async function vaultGetMetadata() {
  const url = accountUrl()
  const result = await flockRequest(a => a.get(url))
  assertSuccess(result.data.metadata, 'getMetadata')
  // Data is encrypted, but `AccountMetadata` is for backwards compatibility
  return result.data.metadata as (AccountMetadata | CryptoResult) || {}
}

export async function vaultSetMetadata(metadata: CryptoResult) {
  const url = accountUrl()
  const result = await flockRequest(a => a.patch(url, { metadata }))
  assertSuccess(result.data.success, 'setMetadata')
}

export async function vaultSetSubscription(
  {
    subscriptionId,
    subscription,
  }: VaultSubscription & { subscriptionId: string },
) {
  const url = subscriptionUrl(subscriptionId)
  const result = await flockRequest(a => a.put(url, { ...subscription }))
  assertSuccess(result.data.success, 'setSubscription')
}

export async function vaultDeleteSubscription({ subscriptionId }: { subscriptionId: string }) {
  const url = subscriptionUrl(subscriptionId)
  const result = await flockRequest(a => a.delete(url))
  assertSuccess(result.data.success, 'deleteSubscription')
}

export async function vaultGetSubscription({ subscriptionId }: { subscriptionId: string }) {
  const url = subscriptionUrl(subscriptionId)
  const result = await flockRequest(a => a.get(url))
  assertSuccess(result.data.success, 'getSubscription')
  return result.data.subscription as FlockPushSubscription | null
}
