import type { AccountMetadata } from '../state/metadata'
import { getAccountId } from './util'
import { trpcClient } from './trpcClient'
import type { CryptoResult } from './Vault'
import type { ItemType, WebPushSubscription } from '../vault/types'

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

export type CachedVaultItem = {
  item: string,
  cipher?: string,
  metadata?: {
    type: ItemType,
    iv: string,
    modified: number,
    version?: number,
  },
}

export type VaultItem = {
  account?: string,
  item: string,
  cipher: string,
  metadata: {
    type: ItemType,
    iv: string,
    modified: number,
    version?: number,
  },
}

export type BatchResultResponse = {
  success: boolean,
  details: Array<{ item: string, success: boolean, error?: string }>,
}

type PutManyResponse =
  | {
    success: true,
    conflicts: string[],
  }
  | {
    success: false,
    error: 'Version conflict',
    conflicts: string[],
  }

export type ReminderSettingsResponse = {
  success: boolean,
  reminderEnabled: boolean,
  reminderTime: string,
  reminderTimezone: string,
}

export class VaultBatchError extends Error {
  failures: Array<{ item: string, error?: string }>

  constructor(failures: Array<{ item: string, error?: string }>) {
    super(`VaultAPI batch operation failed for items: ${failures.map(f => f.item).join(', ')}`)
    this.name = 'VaultBatchError'
    this.failures = failures
  }
}

export class VaultVersionConflictError extends Error {
  conflictIds: string[]

  constructor(conflictIds: string[]) {
    super(`Version conflict for items: ${conflictIds.join(', ')}`)
    this.name = 'VaultVersionConflictError'
    this.conflictIds = conflictIds
  }
}

function assertSuccess(response: { success: boolean }, operation: string) {
  if (!response.success) {
    throw new Error(`VaultAPI ${operation} operation failed`)
  }
}

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
  if (cacheTime === undefined && !ids) {
    throw new Error('Must provide cacheTime or ids')
  }

  const account = getAccountId()
  const data = await trpcClient.items.fetchMany.query({
    account,
    cacheTime,
    ids,
  })
  assertSuccess(data, 'fetchMany')
  return data.items as CachedVaultItem[] | VaultItem[]
}

export async function vaultPut({ cipher, item, metadata }: VaultItem) {
  const response = await trpcClient.items.put.mutate({
    account: getAccountId(),
    item,
    cipher,
    iv: metadata.iv,
    modified: metadata.modified,
    type: metadata.type,
    version: metadata.version,
  })
  assertSuccess(response, 'put')
}

export async function vaultPutMany({ items }: { items: VaultItem[] }) {
  const response = await trpcClient.items.putMany.mutate({
    account: getAccountId(),
    items: items.map(({ cipher, item, metadata }) => ({
      id: item,
      cipher,
      iv: metadata.iv,
      modified: metadata.modified,
      type: metadata.type,
      version: metadata.version,
    })),
  }) as PutManyResponse | BatchResultResponse

  if ('success' in response && response.success && 'conflicts' in response) {
    return
  }

  if (
    'success' in response
    && !response.success
    && 'error' in response
    && response.error === 'Version conflict'
    && 'conflicts' in response
  ) {
    throw new VaultVersionConflictError(response.conflicts)
  }

  if ('details' in response) {
    const failedItems = response.details.filter(d => !d.success)
    if (failedItems.length > 0) {
      throw new VaultBatchError(failedItems.map(f => ({ item: f.item, error: 'error' in f ? f.error : undefined })))
    }
    return
  }

  throw new Error('VaultAPI putMany operation failed')
}

export async function vaultDelete({ item }: { item: string }) {
  const response = await trpcClient.items.delete.mutate({
    account: getAccountId(),
    item,
  })
  assertSuccess(response, 'delete')
}

export async function vaultDeleteMany({ items }: { items: string[] }) {
  const response = await trpcClient.items.deleteMany.mutate({
    account: getAccountId(),
    items,
  })

  const failedItems = response.details.filter(d => !d.success)
  if (failedItems.length > 0) {
    throw new VaultBatchError(failedItems.map(f => ({ item: f.item, error: 'error' in f ? f.error : undefined })))
  }
}

export async function vaultCreateAccount(
  { salt, authToken }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return trpcClient.accounts.createAccount.mutate({ salt, authToken })
}

export async function vaultGetSalt(): Promise<string> {
  const response = await trpcClient.accounts.getSalt.query({ account: getAccountId() })
  assertSuccess(response, 'getSalt')
  if (!response.salt) {
    throw new Error('VaultAPI getSalt: missing salt')
  }
  return response.salt
}

export async function vaultGetSession(authToken: string): Promise<string> {
  const response = await trpcClient.accounts.login.mutate({
    account: getAccountId(),
    authToken,
  })
  assertSuccess(response, 'getSession')
  if (!response.session) {
    throw new Error('VaultAPI getSession: missing session')
  }
  return response.session
}

export async function vaultGetMetadata(): Promise<AccountMetadata | CryptoResult> {
  const response = await trpcClient.accounts.getMetadata.query({ account: getAccountId() })
  assertSuccess(response, 'getMetadata')
  return (response.metadata as AccountMetadata | CryptoResult) || {}
}

export async function vaultSetMetadata(metadata: CryptoResult & { version?: number }): Promise<void> {
  const response = await trpcClient.accounts.updateMetadata.mutate({
    account: getAccountId(),
    metadata: metadata as unknown as Record<string, unknown>,
  })
  assertSuccess(response, 'setMetadata')
}

export async function vaultAddPushSubscription(subscription: WebPushSubscription): Promise<void> {
  const response = await trpcClient.accounts.addPushSubscription.mutate({
    account: getAccountId(),
    endpoint: subscription.endpoint,
    keys: subscription.keys,
  })
  assertSuccess(response, 'addPushSubscription')
}

export async function vaultDeletePushSubscription(endpoint: string): Promise<void> {
  const response = await trpcClient.accounts.deletePushSubscription.mutate({
    account: getAccountId(),
    endpoint,
  })
  assertSuccess(response, 'deletePushSubscription')
}

export async function vaultGetReminderSettings(): Promise<ReminderSettingsResponse> {
  const response = await trpcClient.accounts.getReminderSettings.query({ account: getAccountId() })
  assertSuccess(response, 'getReminderSettings')
  return response
}

export async function vaultUpdateReminderSettings(
  settings: { reminderEnabled: boolean, reminderTime: string, reminderTimezone: string },
): Promise<void> {
  const response = await trpcClient.accounts.updateReminderSettings.mutate({
    account: getAccountId(),
    ...settings,
  })
  assertSuccess(response, 'updateReminderSettings')
}

export async function vaultRecordPrayerCompletion(completedAt: number): Promise<void> {
  const response = await trpcClient.accounts.recordPrayerCompletion.mutate({
    account: getAccountId(),
    completedAt,
  })
  assertSuccess(response, 'recordPrayerCompletion')
}
