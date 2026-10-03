import { z } from 'zod'

import type { WebPushSubscription } from '../types'
import type { ItemId } from 'src/shared/schemas/items'
import {
  VaultKeySchema,
  VaultSessionRecordSchema,
  VaultAccountSchema,
  VaultAccountWithAuthSchema,
  VaultItemSchema,
  StoredSyncMessageSchema,
} from '../../shared/schemas/vault'
import type {
  ManifestEntry,
  SyncMessageLastEvaluatedKey,
  GlobalSyncLastEvaluatedKey,
} from 'src/shared/schemas/trpc'

export type VaultKey = z.infer<typeof VaultKeySchema>
export type VaultSessionRecord = z.infer<typeof VaultSessionRecordSchema>
export type VaultAccount = z.infer<typeof VaultAccountSchema>
export type VaultAccountWithAuth = z.infer<typeof VaultAccountWithAuthSchema>
export type VaultItem = z.infer<typeof VaultItemSchema>
export type StoredSyncMessage = z.infer<typeof StoredSyncMessageSchema>

export interface BaseData {
  account: string,
}

export interface AuthData extends BaseData {
  session: string,
}


export type UpdateAccountDataParams = Partial<AuthData> & {
  metadata?: Record<string, unknown>,
  session?: string,
  sessions?: VaultSessionRecord[],
  pushSubscriptions?: WebPushSubscription[],
  reminderEnabled?: boolean,
  reminderTime?: string,
  reminderTimezone?: string,
  snoozeRemindersUntil?: string | null,
  lastSnapshotCursor?: number,
  lastSnapshotAt?: number,
  lastSnapshotRequestedAt?: number,
  keyring?: string,
  authToken?: string,
  salt?: string,
  iterations?: number,
  saltVersion?: number,
  keyringVersion?: number,
  expectedKeyringVersion?: number,
}


export type VaultDriver = BaseDriver

export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>
  abstract connect(options?: T): BaseDriver<T>

  // Create a new account record. Includes `authToken` and may include a
  // pre-populated `session` for immediate login.
  abstract createAccount(data: VaultAccount): Promise<boolean>

  // Retrieve account data and validate session; `isLogin` instructs implementation
  // to validate against `authToken` instead of session hash.
  abstract getAccount(data: AuthData & { isLogin?: boolean }): Promise<VaultAccountWithAuth>

  abstract getSecurityParams(data: BaseData): Promise<{ salt: string, iterations?: number, saltVersion?: number }>
  abstract getNewAccountId(attempts?: number): Promise<string>

  // Update account-level data. Accepts partial auth data so callers can update
  // either `metadata` or `session` independently.
  abstract updateAccountData(data: UpdateAccountDataParams): Promise<void>

  // Extend session expiry for an account (called on authenticated requests)
  abstract extendSession(data: AuthData): Promise<void>

  // Item CRUD operations
  abstract set(item: VaultItem): Promise<{ version?: number } | void>
  abstract fetchManifest(opts: Pick<VaultKey, 'account'>): Promise<Array<ManifestEntry>>
  abstract fetchByIds(opts: { account: string; itemIds: ItemId[] }): Promise<VaultItem[]>

  // Sync message operations
  abstract appendSyncMessage(input: {
    account: string
    itemId: ItemId
    entry: StoredSyncMessage
  }): Promise<void>

  abstract pushSyncMessagesBatch(input: {
    account: string
    messages: Array<{
      itemId: ItemId
      entry: StoredSyncMessage
      lastModified: number
    }>
  }): Promise<void>

  abstract getSyncMessages(input: {
    account: string
    itemId: ItemId
    fromCursor?: number
    limit?: number
    exclusiveStartKey?: SyncMessageLastEvaluatedKey
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; lastEvaluatedKey?: SyncMessageLastEvaluatedKey }>

  abstract getGlobalSyncMessagesAfterCursor(input: {
    account: string
    cursor?: number
    exclusiveStartKey?: GlobalSyncLastEvaluatedKey
  }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; lastEvaluatedKey?: GlobalSyncLastEvaluatedKey }>
}
