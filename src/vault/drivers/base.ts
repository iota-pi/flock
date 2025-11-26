import { FastifyRequest } from 'fastify'
import type { FlockPushSubscription, ItemType } from '../../shared/apiTypes'
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
}

export interface VaultData {
  metadata: VaultMetaData,
  cipher: string,
}

export interface BaseData {
  account: string,
}

export interface AuthData extends BaseData {
  session: string,
}

export interface VaultAccount extends BaseData {
  metadata: Record<string, unknown>,
  // Salt is not in AuthData since it is only used client-side for logins
  salt: string,
}

export interface VaultAccountWithAuth extends VaultAccount, AuthData {}

export interface VaultItem extends VaultKey, VaultData {}

export type CachedVaultItem = Partial<VaultItem> & Pick<VaultItem, 'item'>

export interface VaultSubscriptionFull extends FlockPushSubscription {
  account: string,
  id: string,
}

export function asItemType(type: string): ItemType {
  const allowedTypes: ItemType[] = ['person', 'group']
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
  abstract updateAccountData(data: Partial<AuthData> & { metadata?: Record<string, unknown>, session?: string }): Promise<void>

  // Item CRUD operations
  abstract set(item: VaultItem): Promise<void>
  abstract get(key: VaultKey): Promise<VaultItem>
  abstract fetchMany(opts: { account: string, ids: string[] }): Promise<VaultItem[]>
  abstract fetchAll(
    { account, cacheTime }: Pick<VaultKey, 'account'> & { cacheTime?: number },
  ): Promise<CachedVaultItem[]>

  abstract delete(key: VaultKey): Promise<void>

  // Subscription management
  abstract setSubscription(data: { account: string, id: string, subscription: FlockPushSubscription }): Promise<void>
  abstract deleteSubscription(data: { account: string, id: string }): Promise<void>
  abstract countSubscriptionFailure(data: { account: string, token: string, maxFailures: number }): Promise<void>
  abstract getSubscription(data: { account: string, id: string }): Promise<FlockPushSubscription | null>

  async auth(request: FastifyRequest) {
    const account = (request.params as { account: string }).account
    const authToken = getAuthToken(request)
    const valid = await this.checkSession({ account, session: authToken })
    if (!valid) {
      throw new HttpError(403, 'Unauthorized')
    }
  }
}
