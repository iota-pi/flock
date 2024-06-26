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

export interface AuthData {
  account: string,
  authToken: Promise<string>,
}

export interface VaultAccount {
  account: string,
  metadata: Record<string, unknown>,
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

  abstract createAccount({ authToken }: AuthData): Promise<boolean>
  abstract getAccount({ account, authToken }: AuthData): Promise<VaultAccountWithAuth>
  abstract checkPassword({ account, authToken }: AuthData): Promise<boolean>
  abstract setMetadata({ account, metadata }: VaultAccount): Promise<void>

  abstract set({ account, item, metadata: { type, iv }, cipher }: VaultItem): Promise<void>
  abstract get({ account, item }: VaultKey): Promise<VaultItem>
  abstract fetchAll(
    { account, cacheTime }: Pick<VaultKey, 'account'> & { cacheTime: number },
  ): Promise<CachedVaultItem[]>

  abstract delete({ account, item }: VaultKey): Promise<void>
}
