import { FastifyRequest } from 'fastify'
import type { ItemType, WebPushSubscription } from '../types'
import type { ItemId, VaultBranch } from '../../shared/itemTypes'
import { getAuthToken } from '../api/util'
import { HttpError } from '../api/errors'

export interface VaultKey {
  account: string,
  item: string,
}

export interface VaultMetaData {
  type: ItemType,
  iv: string,
  modified: number,
  deleted?: boolean,
  compactedAt?: number,
}

/**
 * VaultData: Supports both legacy cipher format and new branches format
 * - Legacy: has cipher, no branches
 * - Branching: has branches array, may or may not have cipher (depending on migration state)
 */
export interface VaultData {
  metadata: VaultMetaData,
  cipher?: string, // Optional for branching format
  branches?: VaultBranch[], // New branching format
  syncMessages?: Array<{
    cursor: number
    encryptedMessage: {
      iv: string
      cipher: string
    }
    createdAt?: number
  }>
}

export interface BaseData {
  account: string,
}

export interface AuthData extends BaseData {
  session: string,
}

export interface VaultSessionRecord {
  token: string,
  expiry: number,
}

export interface VaultAccount extends BaseData {
  metadata: Record<string, unknown>,
  sessions?: VaultSessionRecord[],
  pushSubscriptions?: WebPushSubscription[],
  reminderEnabled?: boolean,
  reminderTime?: string,
  reminderTimezone?: string,
  lastPrayerCompletedAt?: number,
  // Salt and iterations are not in AuthData since they are only used client-side for logins
  salt: string,
  iterations: number,
}

export interface VaultAccountWithAuth extends VaultAccount, AuthData {}

export interface VaultItem extends VaultKey, VaultData {
  ttl?: number,
}

export type CachedVaultItem = Partial<VaultItem> & Pick<VaultItem, 'item'>

export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>
  abstract connect(options?: T): BaseDriver<T>

  // Create a new account record. Includes `authToken` and may include a
  // pre-populated `session` for immediate login.
  abstract createAccount(data: VaultAccountWithAuth & { authToken: string }): Promise<boolean>

  // Check session/authentication. `isLogin` instructs the implementation to
  // validate against `authToken` instead of session hash.
  abstract checkSession(data: AuthData & { isLogin?: boolean }): Promise<{ success: boolean, reason?: string }>

  // Retrieve account data; `isLogin` optional as in `checkSession`.
  abstract getAccount(data: AuthData & { isLogin?: boolean }): Promise<VaultAccountWithAuth>

  abstract getSecurityParams(data: BaseData): Promise<{ salt: string, iterations?: number }>
  abstract getNewAccountId(attempts?: number): Promise<string>

  // Update account-level data. Accepts partial auth data so callers can update
  // either `metadata` or `session` independently.
  abstract updateAccountData(data: Partial<AuthData> & {
    metadata?: Record<string, unknown>,
    expectedMetadataParentVersionId?: string,
    session?: string,
    sessions?: VaultSessionRecord[],
    pushSubscriptions?: WebPushSubscription[],
    reminderEnabled?: boolean,
    reminderTime?: string,
    reminderTimezone?: string,
    lastPrayerCompletedAt?: number,
  }): Promise<void>

  // Extend session expiry for an account (called on authenticated requests)
  abstract extendSession(data: BaseData): Promise<void>

  // Item CRUD operations
  abstract set(item: VaultItem): Promise<void>
  abstract get(key: VaultKey): Promise<VaultItem>
  abstract fetchMany(opts: { account: string, ids: ItemId[] }): Promise<VaultItem[]>
  abstract fetchAll(
    { account, cacheTime }: Pick<VaultKey, 'account'> & { cacheTime?: number },
  ): Promise<CachedVaultItem[]>

  abstract delete(key: VaultKey): Promise<void>

  async auth(request: FastifyRequest) {
    const account = (request.params as { account: string }).account
    const authToken = getAuthToken(request)
    const valid = await this.checkSession({ account, session: authToken })
    if (!valid) {
      throw new HttpError(403, 'Unauthorized')
    }
    // Extend session expiry on successful authentication (fire-and-forget)
    this.extendSession({ account }).catch(() => {})
  }
}
