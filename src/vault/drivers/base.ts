import { FastifyRequest } from 'fastify'

import type { ItemType, WebPushSubscription } from '../types'
import type { VaultSnapshot } from '../../shared/itemTypes'
import { getAuthToken } from '../api/util'
import { HttpError } from '../api/errors'
import type { ItemId } from 'src/shared/schemas/items'


export interface VaultKey {
  account: string,
  item: string,
}

interface VaultMetaData {
  type: ItemType,
  iv: string,
  modified: number,
  deleted?: boolean,
  compactedAt?: number,
}

/**
 * VaultData: Supports both legacy cipher format and snapshot format
 * - Legacy: has cipher and iv
 * - Snapshot: has snapshot payload
 */
interface VaultData {
  metadata: VaultMetaData,
  cipher?: string, // Optional for snapshot format
  snapshot?: VaultSnapshot,
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
  lastSnapshotCursor?: number,
  lastSnapshotAt?: number,
  lastSnapshotRequestedAt?: number,
  // Salt, iterations, and authToken are not in AuthData since they are only used client-side for logins
  authToken: string,
  salt: string,
  iterations: number,
  keyring?: string,
  saltVersion?: number,
}

export interface VaultAccountWithAuth extends VaultAccount, AuthData {}

export interface VaultItem extends VaultKey, VaultData {
  ttl?: number,
}

export type StoredSyncMessage = {
  cursor: number
  encryptedMessage: {
    iv: string
    cipher: string
    version?: string
  }
  createdAt: number
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
  abstract get(key: VaultKey): Promise<VaultItem>
  abstract fetchAll(opts: Pick<VaultKey, 'account'>): Promise<VaultItem[]>
  abstract delete(key: VaultKey): Promise<void>

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

  abstract pruneSyncMessagesUpToCursor(input: {
    account: string
    itemId: ItemId
    cursor: number
  }): Promise<number>

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
