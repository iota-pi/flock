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
}

export interface BaseData {
  account: string,
}

export interface AuthData extends BaseData {
  session: string,
}

export interface VaultAccount extends BaseData {
  metadata: Record<string, unknown>,
  pushSubscriptions?: WebPushSubscription[],
  reminderEnabled?: boolean,
  reminderTime?: string,
  reminderTimezone?: string,
  lastPrayerCompletedAt?: number,
  // Salt is not in AuthData since it is only used client-side for logins
  salt: string,
}

export interface VaultAccountWithAuth extends VaultAccount, AuthData {}

export interface VaultItem extends VaultKey, VaultData {
  ttl?: number,
}

export interface VaultItemHistory {
  account: string,
  historyKey: string,
  itemData: VaultItem,
  expiresAt: number,
}

export interface ArchiveAndReplaceInput {
  history: VaultItemHistory,
  replacement: VaultItem,
}

export interface ArchiveAndSetManyInput {
  historyEntries: VaultItemHistory[],
  replacements: VaultItem[],
}

export type CachedVaultItem = Partial<VaultItem> & Pick<VaultItem, 'item'>

export function asItemType(type: string): ItemType {
  const allowedTypes: ItemType[] = ['person', 'group', 'topic']
  if (allowedTypes.includes(type as ItemType)) {
    return type as ItemType
  }
  throw new Error(`Item type ${type} is not valid`)
}

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

  abstract getAccountSalt(data: BaseData): Promise<string>
  abstract getNewAccountId(attempts?: number): Promise<string>

  // Update account-level data. Accepts partial auth data so callers can update
  // either `metadata` or `session` independently.
  abstract updateAccountData(data: Partial<AuthData> & {
    metadata?: Record<string, unknown>,
    expectedMetadataParentVersionId?: string,
    session?: string,
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
  abstract setMany(items: VaultItem[]): Promise<void>
  abstract get(key: VaultKey): Promise<VaultItem>
  abstract fetchMany(opts: { account: string, ids: ItemId[] }): Promise<VaultItem[]>
  abstract fetchAll(
    { account, cacheTime }: Pick<VaultKey, 'account'> & { cacheTime?: number },
  ): Promise<CachedVaultItem[]>

  abstract putHistory(data: VaultItemHistory): Promise<void>
  abstract fetchHistory(account: string, itemId: ItemId, limit?: number, cursor?: string): Promise<VaultItemHistoryPage>
  abstract archiveAndReplaceTransaction(input: ArchiveAndReplaceInput): Promise<void>
  abstract archiveAndSetManyTransaction(input: ArchiveAndSetManyInput): Promise<void>

  abstract delete(key: VaultKey): Promise<void>

  // Conflict resolution - replace multiple branches with single merged branch
  abstract resolveBranchConflict(
    account: string,
    itemId: string,
    resolvedBranch: {
      encryptedAutomergeDoc: string
      versionId: string
      parentIds: string[]
    },
  ): Promise<void>

  abstract claimIdempotencyKey(
    account: string,
    idempotencyKey: string,
    expiresAt: number,
  ): Promise<boolean>

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
