import type { ItemEnvelope, ItemId } from '../../shared/itemTypes'
import type { WebPushSubscription } from '../../vault/types'
import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'
import { setLastSyncServerTime } from '../../sync/syncServerTimeStore'
import {
  FetchItemsInputSchema,
} from '../../shared/syncSchemas'

export type CreateAccountBody = {
  salt: string,
  authToken: string,
}

export type AccountCreationResponse = {
  account: string,
}

export type LoginBody = {
  authToken: string,
}

export type CachedVaultItem = ItemEnvelope & {
  ttl?: number,
}

/**
 * VaultItem: Legacy format for backwards compatibility.
 * Extends ItemEnvelope to support both legacy cipher and new branches.
 */
export type VaultItem = ItemEnvelope & {
  account?: string,
  ttl?: number,
  syncMessages?: Array<{
    cursor: number
    encryptedMessage: {
      iv: string
      cipher: string
    }
    createdAt?: number
  }>
}

export type FetchManyResponse<TItem> = {
  success: boolean,
  items: TItem[],
  serverTime: number,
}

export type ReminderSettingsResponse = {
  success: boolean,
  reminderEnabled: boolean,
  reminderTime: string,
  reminderTimezone: string,
}

function assertSuccess(response: { success: boolean }, operation: string) {
  if (!response.success) {
    throw new Error(`Vault client ${operation} operation failed`)
  }
}

export async function fetchMany(params: { cacheTime: number | null; ids?: never }): Promise<{ items: CachedVaultItem[], serverTime: number }>
export async function fetchMany(params: { cacheTime?: never; ids: ItemId[] }): Promise<{ items: VaultItem[], serverTime: number }>
export async function fetchMany({
  cacheTime,
  ids,
}: {
  cacheTime?: number | null,
  ids?: ItemId[],
}): Promise<{ items: CachedVaultItem[] | VaultItem[], serverTime: number }> {
  if (cacheTime !== undefined && ids) {
    throw new Error('Cannot use cacheTime and ids together')
  }
  if (cacheTime === undefined && !ids) {
    throw new Error('Must provide cacheTime or ids')
  }

  const account = getAccountId()
  const input = FetchItemsInputSchema.parse({
    account,
    cacheTime,
    ids,
  })
  const data = await trpcClient.items.fetchMany.query(input)
  assertSuccess(data, 'fetchMany')

  const serverTime = typeof data.serverTime === 'number' ? data.serverTime : Date.now()
  if (serverTime > 0) {
    setLastSyncServerTime(account, serverTime)
  }

  return {
    items: data.items as CachedVaultItem[] | VaultItem[],
    serverTime,
  }
}

export async function createAccount(
  { salt, authToken }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return trpcClient.accounts.createAccount.mutate({ salt, authToken })
}

export async function getSalt(): Promise<string> {
  const response = await trpcClient.accounts.getSalt.query({ account: getAccountId() })
  assertSuccess(response, 'getSalt')
  if (!response.salt) {
    throw new Error('Vault client getSalt: missing salt')
  }
  return response.salt
}

export async function getSession(authToken: string): Promise<string> {
  const response = await trpcClient.accounts.login.mutate({
    account: getAccountId(),
    authToken,
  })
  assertSuccess(response, 'getSession')
  if (!response.session) {
    throw new Error('Vault client getSession: missing session')
  }
  return response.session
}

export async function addPushSubscription(subscription: WebPushSubscription): Promise<void> {
  const response = await trpcClient.accounts.addPushSubscription.mutate({
    account: getAccountId(),
    endpoint: subscription.endpoint,
    keys: subscription.keys,
  })
  assertSuccess(response, 'addPushSubscription')
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const response = await trpcClient.accounts.deletePushSubscription.mutate({
    account: getAccountId(),
    endpoint,
  })
  assertSuccess(response, 'deletePushSubscription')
}

export async function getReminderSettings(): Promise<ReminderSettingsResponse> {
  const response = await trpcClient.accounts.getReminderSettings.query({ account: getAccountId() })
  assertSuccess(response, 'getReminderSettings')
  return response
}

export async function updateReminderSettings(
  settings: { reminderEnabled: boolean, reminderTime: string, reminderTimezone: string },
): Promise<void> {
  const response = await trpcClient.accounts.updateReminderSettings.mutate({
    account: getAccountId(),
    ...settings,
  })
  assertSuccess(response, 'updateReminderSettings')
}

export async function recordPrayerCompletion(completedAt: number): Promise<void> {
  const response = await trpcClient.accounts.recordPrayerCompletion.mutate({
    account: getAccountId(),
    completedAt,
  })
  assertSuccess(response, 'recordPrayerCompletion')
}
