import { QueryClient } from '@tanstack/react-query'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import createClient from 'openapi-fetch'
import env from '../env'
import type { paths } from '../shared/schema'
import { useUiStore } from '../state/uiStore'
import { initialState as initialAccountState } from '../state/account'
import type { AccountState } from '../state/account'

// Query Keys
export const queryKeys = {
  account: ['account'] as const,
  items: ['items'] as const,
  metadata: ['metadata'] as const,
}

export function getAccountState(): AccountState {
  return queryClient.getQueryData<AccountState>(queryKeys.account) || initialAccountState
}

export function setAccountState(payload: Partial<AccountState>) {
  queryClient.setQueryData<AccountState>(
    queryKeys.account,
    (previous) => ({
      ...(previous || initialAccountState),
      ...payload,
    }),
  )
}

// Create a query client instance with TanStack Query's native caching
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Data is considered fresh for 5 minutes
      staleTime: 5 * 60 * 1000,
      // Keep unused data in cache for 24 hours
      gcTime: 24 * 60 * 60 * 1000,
      retry: 2,
      // Refetch when user returns to the app
      refetchOnWindowFocus: true,
    },
  },
})

// Create a persister to save cache to localStorage
const CACHE_KEY = 'flock-query-cache'

export const queryPersister = createAsyncStoragePersister({
  storage: window.localStorage,
  key: CACHE_KEY,
})

let authToken = ''
let onSessionExpired: (() => void) | null = null

function startRequest() {
  useUiStore.getState().startRequest()
}

function finishRequest(error?: string) {
  useUiStore.getState().finishRequest(error)
}

async function trackedFetch(input: RequestInfo | URL, init?: RequestInit) {
  startRequest()

  try {
    const headers = new Headers(init?.headers)
    if (authToken) {
      headers.set('Authorization', `Basic ${authToken}`)
    }

    const response = await fetch(input, {
      ...init,
      headers,
    })

    if (response.status === 403 && onSessionExpired) {
      onSessionExpired()
    }

    finishRequest(response.ok ? undefined : 'A request to the server failed. Please retry later.')
    return response
  } catch (error) {
    finishRequest('A request to the server failed. Please retry later.')
    throw error
  }
}

export const apiClient = createClient<paths>({
  baseUrl: env.VAULT_ENDPOINT,
  fetch: trackedFetch,
})

export function setApiAuthToken(nextAuthToken: string) {
  authToken = nextAuthToken
}

export function setApiSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler
}

export function hasApiAuthToken() {
  return !!authToken
}

type JsonBody<T> = T extends { content: { 'application/json': infer U } } ? U : never

type CreateAccountOperation = paths['/account']['post']
type LoginOperation = paths['/{account}/login']['post']
type MetadataGetOperation = paths['/{account}']['get']
type MetadataPatchOperation = paths['/{account}']['patch']
type SaltOperation = paths['/{account}/salt']['get']
type ItemsGetOperation = paths['/{account}/items']['get']
type ItemsPutOperation = paths['/{account}/items']['put']
type ItemsDeleteOperation = paths['/{account}/items']['delete']
type ItemPutOperation = paths['/{account}/items/{item}']['put']
type ItemDeleteOperation = paths['/{account}/items/{item}']['delete']
type PushSubscriptionPostOperation = paths['/{account}/push-subscriptions']['post']
type PushSubscriptionDeleteOperation = paths['/{account}/push-subscriptions']['delete']
type ReminderSettingsGetOperation = paths['/{account}/reminder-settings']['get']
type ReminderSettingsPostOperation = paths['/{account}/reminder-settings']['post']
type PrayerCompletionPostOperation = paths['/{account}/prayer-completion']['post']

export type CreateAccountBody = JsonBody<CreateAccountOperation['requestBody']>
export type AccountCreationResponse = JsonBody<CreateAccountOperation['responses'][200]>
export type LoginBody = JsonBody<LoginOperation['requestBody']>
export type SessionResponse = JsonBody<LoginOperation['responses'][200]>
export type MetadataResponse = JsonBody<MetadataGetOperation['responses'][200]>
export type UpdateMetadataBody = JsonBody<MetadataPatchOperation['requestBody']>
export type SaltResponse = JsonBody<SaltOperation['responses'][200]>
export type ItemsResponse = JsonBody<ItemsGetOperation['responses'][200]>
export type CachedVaultItem = ItemsResponse['items'][number]
export type VaultItem = CachedVaultItem & {
  cipher: string,
  metadata: NonNullable<CachedVaultItem['metadata']>,
}
export type PutItemsBatchBody = JsonBody<ItemsPutOperation['requestBody']>
export type DeleteItemsBatchBody = JsonBody<ItemsDeleteOperation['requestBody']>
export type PutItemBody = JsonBody<ItemPutOperation['requestBody']>
export type SuccessResponse = JsonBody<ItemDeleteOperation['responses'][200]>
export type BatchResultResponse = JsonBody<ItemsPutOperation['responses'][200]>
export type PushSubscriptionBody = JsonBody<PushSubscriptionPostOperation['requestBody']>
export type PushSubscriptionDeleteBody = JsonBody<PushSubscriptionDeleteOperation['requestBody']>
export type WebPushSubscription = PushSubscriptionBody
export type ReminderSettingsBody = JsonBody<ReminderSettingsPostOperation['requestBody']>
export type ReminderSettingsResponse = JsonBody<ReminderSettingsGetOperation['responses'][200]>
export type PrayerCompletionBody = JsonBody<PrayerCompletionPostOperation['requestBody']>

// Error handling helper
export function handleVaultError(error: Error, message: string) {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    return
  }
  console.error(error)
  useUiStore.getState().setUi({
    message: {
      message,
      severity: 'error',
    },
  })
}

// Helper to clear the cache (e.g., on logout)
export function clearQueryCache() {
  queryClient.clear()
}
