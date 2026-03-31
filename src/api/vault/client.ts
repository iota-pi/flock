import type { AccountMetadata } from '../../state/metadata'
import type { ItemEnvelope, ItemId, VaultBranch } from '../../shared/itemTypes'
import type { WebPushSubscription } from '../../vault/types'
import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'
import {
  FetchItemsInputSchema,
  PutItemBodySchema,
  PutItemsBatchBodySchema,
  UpdateMetadataBodySchema,
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
}

export type BatchResultResponse = {
  success: boolean,
  details: Array<{ item: ItemId, success: boolean, error?: string }>,
}

export type FetchManyResponse<TItem> = {
  success: boolean,
  items: TItem[],
  serverTime: number,
}

type PutManyResponse =
  | {
    success: true,
    conflicts: ItemId[],
  }
  | {
    success: false,
    error: 'Version conflict',
    conflicts: ItemId[],
  }

type PutResponse =
  | {
    success: true,
  }
  | {
    success: false,
    error: 'Version conflict',
    conflicts: ItemId[],
  }

export type ReminderSettingsResponse = {
  success: boolean,
  reminderEnabled: boolean,
  reminderTime: string,
  reminderTimezone: string,
}

export type VaultMetadataEnvelope =
  | AccountMetadata
  | {
    cipher: string
    iv: string
  }
  | {
    branches: VaultBranch[]
  }

export class VaultBatchError extends Error {
  failures: Array<{ item: ItemId, error?: string }>

  constructor(failures: Array<{ item: ItemId, error?: string }>) {
    super(`Vault client batch operation failed for items: ${failures.map(f => f.item).join(', ')}`)
    this.name = 'VaultBatchError'
    this.failures = failures
  }
}

export class VaultVersionConflictError extends Error {
  conflictIds: ItemId[]

  constructor(conflictIds: ItemId[]) {
    super(`Version conflict for items: ${conflictIds.join(', ')}`)
    this.name = 'VaultVersionConflictError'
    this.conflictIds = conflictIds
  }
}

function extractConflictIdsFromError(error: unknown): ItemId[] {
  const maybeAny = error as {
    message?: unknown
    cause?: { conflicts?: unknown }
    data?: { code?: unknown; cause?: { conflicts?: unknown } }
  }

  const fromCause = maybeAny?.cause?.conflicts
  if (Array.isArray(fromCause)) {
    return fromCause.filter((item): item is string => typeof item === 'string')
  }

  const fromDataCause = maybeAny?.data?.cause?.conflicts
  if (Array.isArray(fromDataCause)) {
    return fromDataCause.filter((item): item is string => typeof item === 'string')
  }

  const message = typeof maybeAny?.message === 'string' ? maybeAny.message : ''
  const prefix = 'VERSION_CONFLICT:'
  if (message.startsWith(prefix)) {
    const serializedIds = message.slice(prefix.length).trim()
    if (!serializedIds) {
      return []
    }
    return serializedIds.split(',').map(id => id.trim()).filter(Boolean)
  }

  return []
}

function isConflictTrpcError(error: unknown): boolean {
  const maybeAny = error as {
    data?: { code?: unknown }
    message?: unknown
  }

  if (maybeAny?.data?.code === 'CONFLICT') {
    return true
  }

  const message = typeof maybeAny?.message === 'string' ? maybeAny.message : ''
  return message.startsWith('VERSION_CONFLICT:')
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

  return {
    items: data.items as CachedVaultItem[] | VaultItem[],
    serverTime: typeof data.serverTime === 'number' ? data.serverTime : Date.now(),
  }
}

export async function put(item: VaultItem) {
  const input = PutItemBodySchema.parse({
    account: getAccountId(),
    item: item.item,
    branches: item.branches || [],
    modified: item.metadata.modified,
    type: item.metadata.type,
    deleted: item.metadata.deleted,
  })

  try {
    await trpcClient.items.put.mutate(input)
  } catch (error) {
    if (isConflictTrpcError(error)) {
      throw new VaultVersionConflictError(extractConflictIdsFromError(error))
    }

    throw error
  }
}

export async function putMany({ items }: { items: VaultItem[] }) {
  const input = PutItemsBatchBodySchema.parse({
    account: getAccountId(),
    items: items.map(item => ({
      id: item.item,
      branches: item.branches || [],
      modified: item.metadata.modified,
      type: item.metadata.type,
      deleted: item.metadata.deleted,
    })),
  })

  try {
    await trpcClient.items.putMany.mutate(input)
  } catch (error) {
    if (isConflictTrpcError(error)) {
      throw new VaultVersionConflictError(extractConflictIdsFromError(error))
    }

    throw error
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

export async function getMetadata(): Promise<VaultMetadataEnvelope> {
  const response = await trpcClient.accounts.getMetadata.query({ account: getAccountId() })
  assertSuccess(response, 'getMetadata')
  return (response.metadata as VaultMetadataEnvelope) || {}
}

export async function setMetadata(metadata: Record<string, unknown>): Promise<void> {
  const input = UpdateMetadataBodySchema.parse({
    account: getAccountId(),
    metadata,
  })
  const response = await trpcClient.accounts.updateMetadata.mutate(input)
  assertSuccess(response, 'setMetadata')
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
