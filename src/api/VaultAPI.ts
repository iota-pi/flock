import type { AccountMetadata } from '../state/account'
import { apiClient } from './client'
import type {
  AccountCreationResponse,
  BatchResultResponse,
  CachedVaultItem,
  CreateAccountBody,
  LoginBody,
  PrayerCompletionBody,
  PushSubscriptionBody,
  PushSubscriptionDeleteBody,
  ReminderSettingsBody,
  ReminderSettingsResponse,
  VaultItem,
  WebPushSubscription,
} from './client'
import { getAccountId } from './util'
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

function getErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'error' in error && typeof error.error === 'string') {
    return error.error
  }
  return undefined
}

function assertApiResult<T>(
  result: { data?: T; error?: unknown; response: Response },
  operation: string,
): T {
  if (result.response.ok && result.data !== undefined) {
    return result.data
  }

  const message = getErrorMessage(result.error)
  throw new Error(message ? `VaultAPI ${operation}: ${message}` : `VaultAPI ${operation} request failed`)
}

type VaultKey = { item: string }

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
  const account = getAccountId()
  if (cacheTime !== undefined) {
    const result = await apiClient.GET('/{account}/items', {
      params: {
        path: { account },
        query: cacheTime ? { since: cacheTime } : {},
      },
    })
    const data = assertApiResult(result, 'fetchMany')
    assertSuccess(data, 'fetchMany')
    return data.items
  } else if (ids) {
    const result: CachedVaultItem[] = []
    const workingIds = ids.slice()

    while (workingIds.length > 0) {
      const batch = workingIds.splice(0, 10)
      const response = await apiClient.GET('/{account}/items', {
        params: {
          path: { account },
          query: { ids: batch.join(',') },
        },
      })
      const data = assertApiResult(response, 'fetchMany')
      assertSuccess(data, 'fetchMany')
      result.push(...data.items)
    }

    return result as VaultItem[]
  } else {
    throw new Error('Must provide cacheTime or ids')
  }
}

export async function vaultPut({ cipher, item, metadata }: VaultItem) {
  const response = await apiClient.PUT('/{account}/items/{item}', {
    params: {
      path: {
        account: getAccountId(),
        item,
      },
    },
    body: { cipher, ...metadata },
  })
  const data = assertApiResult(response, 'put')
  assertSuccess(data, 'put')
}

export async function vaultPutMany({ items }: { items: VaultItem[] }) {
  const account = getAccountId()
  const data = items.map(({ cipher, item, metadata }) => ({ cipher, id: item, ...metadata }))
  const results: BatchResultResponse[] = []

  for (let i = 0; i < data.length; i += 10) {
    const batch = data.slice(i, i + 10)
    const response = await apiClient.PUT('/{account}/items', {
      params: { path: { account } },
      body: batch,
    })
    results.push(assertApiResult(response, 'putMany'))
  }

  const failedItems = results.flatMap(r => r.details.filter(d => !d.success))
  if (failedItems.length > 0) {
    throw new VaultBatchError(failedItems.map(f => ({ item: f.item, error: f.error })))
  }
}

export async function vaultDelete({ item }: VaultKey) {
  const response = await apiClient.DELETE('/{account}/items/{item}', {
    params: {
      path: {
        account: getAccountId(),
        item,
      },
    },
  })
  const data = assertApiResult(response, 'delete')
  assertSuccess(data, 'delete')
}

export async function vaultDeleteMany({ items }: { items: string[] }) {
  const account = getAccountId()
  const results: BatchResultResponse[] = []

  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10)
    const response = await apiClient.DELETE('/{account}/items', {
      params: { path: { account } },
      body: batch,
    })
    results.push(assertApiResult(response, 'deleteMany'))
  }

  const failedItems = results.flatMap(r => r.details.filter(d => !d.success))
  if (failedItems.length > 0) {
    throw new VaultBatchError(failedItems.map(f => ({ item: f.item, error: f.error })))
  }
}

export async function vaultCreateAccount(
  { salt, authToken }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  const response = await apiClient.POST('/account', {
    body: { salt, authToken },
  })
  const data = assertApiResult(response, 'createAccount')
  return { account: data.account }
}

export async function vaultGetSalt(): Promise<string> {
  const response = await apiClient.GET('/{account}/salt', {
    params: { path: { account: getAccountId() } },
  })
  const data = assertApiResult(response, 'getSalt')
  assertSuccess(data, 'getSalt')
  assertDefined(data.salt, 'getSalt', 'salt')
  return data.salt
}

export async function vaultGetSession(authToken: string): Promise<string> {
  const body: LoginBody = { authToken }
  const response = await apiClient.POST('/{account}/login', {
    params: { path: { account: getAccountId() } },
    body,
  })
  const data = assertApiResult(response, 'getSession')
  assertSuccess(data, 'getSession')
  assertDefined(data.session, 'getSession', 'session')
  return data.session
}

export async function vaultGetMetadata(): Promise<AccountMetadata | CryptoResult> {
  const response = await apiClient.GET('/{account}', {
    params: { path: { account: getAccountId() } },
  })
  const data = assertApiResult(response, 'getMetadata')
  assertSuccess(data, 'getMetadata')
  // Data is encrypted, but `AccountMetadata` is for backwards compatibility
  return (data.metadata as AccountMetadata | CryptoResult) || {}
}

export async function vaultSetMetadata(metadata: CryptoResult & { version?: number }): Promise<void> {
  const response = await apiClient.PATCH('/{account}', {
    params: { path: { account: getAccountId() } },
    body: { metadata: metadata as unknown as Record<string, unknown> },
  })
  const data = assertApiResult(response, 'setMetadata')
  assertSuccess(data, 'setMetadata')
}

export async function vaultAddPushSubscription(subscription: WebPushSubscription): Promise<void> {
  const body: PushSubscriptionBody = { ...subscription }
  const response = await apiClient.POST('/{account}/push-subscriptions', {
    params: { path: { account: getAccountId() } },
    body,
  })
  const data = assertApiResult(response, 'addPushSubscription')
  assertSuccess(data, 'addPushSubscription')
}

export async function vaultDeletePushSubscription(endpoint: string): Promise<void> {
  const body: PushSubscriptionDeleteBody = { endpoint }
  const response = await apiClient.DELETE('/{account}/push-subscriptions', {
    params: { path: { account: getAccountId() } },
    body,
  })
  const data = assertApiResult(response, 'deletePushSubscription')
  assertSuccess(data, 'deletePushSubscription')
}

export async function vaultGetReminderSettings(): Promise<ReminderSettingsResponse> {
  const response = await apiClient.GET('/{account}/reminder-settings', {
    params: { path: { account: getAccountId() } },
  })
  const data = assertApiResult(response, 'getReminderSettings')
  assertSuccess(data, 'getReminderSettings')
  return data
}

export async function vaultUpdateReminderSettings(settings: ReminderSettingsBody): Promise<void> {
  const response = await apiClient.POST('/{account}/reminder-settings', {
    params: { path: { account: getAccountId() } },
    body: settings,
  })
  const data = assertApiResult(response, 'updateReminderSettings')
  assertSuccess(data, 'updateReminderSettings')
}

export async function vaultRecordPrayerCompletion(completedAt: number): Promise<void> {
  const body: PrayerCompletionBody = { completedAt }
  const response = await apiClient.POST('/{account}/prayer-completion', {
    params: { path: { account: getAccountId() } },
    body,
  })
  const data = assertApiResult(response, 'recordPrayerCompletion')
  assertSuccess(data, 'recordPrayerCompletion')
}
