import { FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { WebPushSubscription } from '../types'
import { getAuthToken } from '../api/util'
import { HttpError } from '../api/errors'
import type { ItemId } from 'src/shared/schemas/items'
import {
  VaultKeySchema,
  VaultMetaDataSchema,
  VaultSessionRecordSchema,
  VaultAccountSchema,
  VaultAccountWithAuthSchema,
  VaultItemSchema,
  StoredSyncMessageSchema,
} from '../../shared/schemas/vault'

export type VaultKey = z.infer<typeof VaultKeySchema>
export type VaultMetaData = z.infer<typeof VaultMetaDataSchema>
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


export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>
  abstract connect(options?: T): BaseDriver<T>

  // Create a new account record. Includes `authToken` and may include a
  // pre-populated `session` for immediate login.
  abstract createAccount(data: VaultAccount): Promise<boolean>

  // Check session/authentication. `isLogin` instructs the implementation to
  // validate against `authToken` instead of session hash.
  abstract checkSession(data: AuthData & { isLogin?: boolean }): Promise<{ success: boolean, reason?: string }>

  // Retrieve account data; `isLogin` optional as in `checkSession`.
  abstract getAccount(data: AuthData & { isLogin?: boolean }): Promise<VaultAccountWithAuth>

  abstract getSecurityParams(data: BaseData): Promise<{ salt: string, iterations?: number, saltVersion?: number }>
  abstract getNewAccountId(attempts?: number): Promise<string>

  // Update account-level data. Accepts partial auth data so callers can update
  // either `metadata` or `session` independently.
  abstract updateAccountData(data: Partial<AuthData> & {
    metadata?: Record<string, unknown>,
    session?: string,
    sessions?: VaultSessionRecord[],
    pushSubscriptions?: WebPushSubscription[],
    reminderEnabled?: boolean,
    reminderTime?: string,
    reminderTimezone?: string,
    lastPrayerCompletedAt?: number,
    lastSnapshotCursor?: number,
    lastSnapshotAt?: number,
    lastSnapshotRequestedAt?: number,
    latestSyncCursor?: number,
    keyring?: string,
    authToken?: string,
    salt?: string,
    iterations?: number,
    saltVersion?: number,
  }): Promise<void>

  // Extend session expiry for an account (called on authenticated requests)
  abstract extendSession(data: AuthData): Promise<void>

  // Item CRUD operations
  abstract set(item: VaultItem): Promise<void>
  abstract fetchManifest(opts: Pick<VaultKey, 'account'>): Promise<Array<{ itemId: string; modifiedAt: number }>>
  abstract fetchByIds(opts: { account: string; itemIds: string[] }): Promise<VaultItem[]>

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
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean }>

  abstract getGlobalSyncMessagesAfterCursor(input: {
    account: string
    cursor: number
  }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean }>

  async auth(request: FastifyRequest) {
    const account = (request.params as { account: string }).account
    const authToken = getAuthToken(request)
    const valid = await this.checkSession({ account, session: authToken })
    if (!valid) {
      throw new HttpError(403, 'Unauthorized')
    }
    // Extend session expiry on successful authentication (fire-and-forget)
    this.extendSession({ account, session: authToken }).catch(() => {})
  }
}
