import { FlockPushSubscription } from '../../app/src/utils/firebase-types'

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
  authToken: Promise<string>,
}

export interface VaultAccount extends BaseData {
  metadata: Record<string, unknown>,
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
  abstract checkPassword(data: AuthData): Promise<boolean>
  abstract getAccount(data: AuthData): Promise<VaultAccountWithAuth>
  abstract getAccountSalt(data: BaseData): Promise<string>
  abstract getNewAccountId(): Promise<string>
  abstract setMetadata(data: AuthData & Pick<VaultAccount, 'metadata'>): Promise<void>

  abstract set({ account, item, metadata: { type, iv }, cipher }: VaultItem): Promise<void>
  abstract get({ account, item }: VaultKey): Promise<VaultItem>
  abstract fetchAll(
    { account, cacheTime }: Pick<VaultKey, 'account'> & { cacheTime: number },
  ): Promise<CachedVaultItem[]>

  abstract delete({ account, item }: VaultKey): Promise<void>
}
