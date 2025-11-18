import { FastifyReply, FastifyRequest } from 'fastify'
import { FlockPushSubscription } from '../../app/src/utils/firebase-types'
import { getAuthToken } from '../api/util'

export type VaultItemType = 'person' | 'group'

export interface VaultKey {
  account: string,
  item: string,
}

export interface VaultMetaData {
  type: VaultItemType,
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

export function asItemType(type: string): VaultItemType {
  const allowedTypes: VaultItemType[] = ['person', 'group']
  if (allowedTypes.includes(type as VaultItemType)) {
    return type as VaultItemType
  }
  throw new Error(`Item type ${type} is not valid`)
}

export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>
  abstract connect(options?: T): BaseDriver<T>

  abstract createAccount(data: BaseData & VaultAccount): Promise<boolean>
  abstract checkSession(data: AuthData): Promise<{ success: boolean, reason?: string }>
  abstract getAccount(data: AuthData): Promise<VaultAccountWithAuth>
  abstract getAccountSalt(data: BaseData): Promise<string>
  abstract getNewAccountId(): Promise<string>
  abstract updateAccountData(data: AuthData & Pick<VaultAccount, 'metadata'>): Promise<void>

  abstract set({ account, item, metadata: { type, iv }, cipher }: VaultItem): Promise<void>
  abstract get({ account, item }: VaultKey): Promise<VaultItem>
  abstract fetchAll(
    { account, cacheTime }: Pick<VaultKey, 'account'> & { cacheTime: number },
  ): Promise<CachedVaultItem[]>

  abstract delete({ account, item }: VaultKey): Promise<void>

  async auth(request: FastifyRequest, reply: FastifyReply) {
    const account = (request.params as { account: string }).account
    const authToken = getAuthToken(request)
    const valid = await this.checkSession({ account, session: authToken })
    if (!valid) {
      reply.code(403)
      throw new Error('Unauthorized')
    }
  }
}
