import type { AccountMetadata } from '../state/account'
import type {
  AccountCreationResponse,
  BatchResultResponse,
  CachedVaultItem,
  CreateAccountBody,
  FlockPushSubscription,
  ItemsResponse,
  LoginBody,
  MetadataResponse,
  SaltResponse,
  SessionResponse,
  SubscriptionBody,
  SubscriptionGetResponse,
  SuccessResponse,
  VaultItem,
  VaultKey,
  VaultSubscription,
} from '../shared/apiTypes'
import { getAccountId, flockRequestChunked, flockRequest } from './util'
import type { CryptoResult } from './Vault'

export class VaultBatchError extends Error {
  failures: Array<{ item: string, error?: string }>

  constructor(failures: Array<{ item: string, error?: string }>) {
    super(`VaultAPI batch operation failed for items: ${failures.map(f => f.item).join(', ')}`)
    this.name = 'VaultBatchError'
    this.failures = failures
  }
}

// Helper to check success flag and throw on failure
function assertSuccess<T extends { success: boolean }>(response: T, operation: string): asserts response is T & { success: true } {
  if (!response.success) {
    throw new Error(`VaultAPI ${operation} operation failed`)
  }
}

// Helper to assert a value is defined
function assertDefined<T>(value: T | undefined | null, operation: string, field: string): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(`VaultAPI ${operation}: missing ${field}`)
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

// Overloads for vaultFetchMany - cacheTime returns partial items, ids returns full items
export async function vaultFetchMany(params: { cacheTime: number | null; ids?: never }): Promise<CachedVaultItem[]>
export async function vaultFetchMany(params: { cacheTime?: never; ids: string[] }): Promise<VaultItem[]>
export async function vaultFetchMany({
  cacheTime,
  ids,
}: {
  cacheTime?: number | null,
  ids?: string[],
}): Promise<CachedVaultItem[] | VaultItem[]> {
  if (cacheTime !== undefined && ids) {
    throw new Error('Cannot use cacheTime and ids together')
  }
  const url = itemsUrl()
  if (cacheTime !== undefined) {
    let urlWithQuery = url
    if (cacheTime) {
      urlWithQuery = `${url}?since=${cacheTime}`
    }
    const result = await flockRequest<ItemsResponse>(a => a.get(urlWithQuery))
    return result.items
  } else if (ids) {
    const result = await flockRequestChunked<string[], ItemsResponse>(
      {
        data: [ids],
        requestFactory: (
          a => batch => a.get(
            `${url}?ids=${batch.join(',')}`
          )
        ),
      },
    )
    return result.flatMap(r => r.items)
  } else {
    throw new Error('Must provide cacheTime or ids')
  }
}

export async function vaultPut({ cipher, item, metadata }: VaultItem) {
  const url = itemsUrl(item)
  const result = await flockRequest<SuccessResponse>(
    a => a.put(url, { cipher, ...metadata }),
  )
  assertSuccess(result, 'put')
}

export async function vaultPutMany({ items }: { items: VaultItem[] }) {
  const url = itemsUrl()
  const data = items.map(({ cipher, item, metadata }) => ({ cipher, id: item, ...metadata }))
  const results = await flockRequestChunked<typeof data[number], BatchResultResponse>(
    {
      data,
      requestFactory: a => batch => a.put(url, batch),
    },
  )
  const failedItems = results.flatMap(r => r.details.filter(d => !d.success))
  if (failedItems.length > 0) {
    throw new VaultBatchError(failedItems.map(f => ({ item: f.item, error: f.error })))
  }
}

export async function vaultDelete({ item }: VaultKey) {
  const url = itemsUrl(item)
  const result = await flockRequest<SuccessResponse>(a => a.delete(url))
  assertSuccess(result, 'delete')
}

export async function vaultDeleteMany({ items }: { items: string[] }) {
  const url = itemsUrl()
  const results = await flockRequestChunked<string, BatchResultResponse>(
    {
      data: items,
      requestFactory: a => batch => a.delete(url, { data: batch }),
    },
  )
  const failedItems = results.flatMap(r => r.details.filter(d => !d.success))
  if (failedItems.length > 0) {
    throw new VaultBatchError(failedItems.map(f => ({ item: f.item, error: f.error })))
  }
}

export async function vaultCreateAccount(
  { salt, authToken }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  const url = '/account'
  const result = await flockRequest<AccountCreationResponse>({
    factory: a => a.post(url, { salt, authToken }),
    options: { allowNoInit: true },
  })
  return { account: result.account }
}

export async function vaultGetSalt(): Promise<string> {
  const url = accountUrl('/salt')
  const result = await flockRequest<SaltResponse>({
    factory: a => a.get(url),
    options: { allowNoInit: true },
  })
  assertSuccess(result, 'getSalt')
  assertDefined(result.salt, 'getSalt', 'salt')
  return result.salt
}

export async function vaultGetSession(authToken: string): Promise<string> {
  const url = accountUrl('/login')
  const body: LoginBody = { authToken }
  const result = await flockRequest<SessionResponse>({
    factory: a => a.post(url, body),
    options: { allowNoInit: true },
  })
  assertSuccess(result, 'getSession')
  assertDefined(result.session, 'getSession', 'session')
  return result.session
}

export async function vaultGetMetadata(): Promise<AccountMetadata | CryptoResult> {
  const url = accountUrl()
  const result = await flockRequest<MetadataResponse>(a => a.get(url))
  assertSuccess(result, 'getMetadata')
  // Data is encrypted, but `AccountMetadata` is for backwards compatibility
  return (result.metadata as AccountMetadata | CryptoResult) || {}
}

export async function vaultSetMetadata(metadata: CryptoResult): Promise<void> {
  const url = accountUrl()
  const result = await flockRequest<SuccessResponse>(a => a.patch(url, { metadata }))
  assertSuccess(result, 'setMetadata')
}

export async function vaultSetSubscription(
  {
    subscriptionId,
    subscription,
  }: VaultSubscription & { subscriptionId: string },
): Promise<void> {
  const url = subscriptionUrl(subscriptionId)
  const body: SubscriptionBody = { ...subscription }
  const result = await flockRequest<SuccessResponse>(a => a.put(url, body))
  assertSuccess(result, 'setSubscription')
}

export async function vaultDeleteSubscription({ subscriptionId }: { subscriptionId: string }): Promise<void> {
  const url = subscriptionUrl(subscriptionId)
  const result = await flockRequest<SuccessResponse>(a => a.delete(url))
  assertSuccess(result, 'deleteSubscription')
}

export async function vaultGetSubscription({ subscriptionId }: { subscriptionId: string }): Promise<FlockPushSubscription | null> {
  const url = subscriptionUrl(subscriptionId)
  const result = await flockRequest<SubscriptionGetResponse>(a => a.get(url))
  assertSuccess(result, 'getSubscription')
  return result.subscription
}
