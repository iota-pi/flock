export type VaultItemType = 'person' | 'group' | 'general';

export interface VaultKey {
  account: string,
  item: string,
}

export interface VaultMetaData {
  type: VaultItemType,
  iv: string,
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
  metadata: Record<string, any>,
}

export interface VaultAccountWithAuth extends VaultAccount, AuthData {}

export interface VaultItem extends VaultKey, VaultData {}

export function asItemType(type: string): VaultItemType {
  const allowedTypes: VaultItemType[] = ['person', 'group', 'general'];
  if (allowedTypes.includes(type as VaultItemType)) {
    return type as VaultItemType;
  }
  throw new Error(`Item type ${type} is not valid`);
}

export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>;
  abstract connect(options?: T): BaseDriver<T>;

  abstract createAccount({ authToken }: AuthData): Promise<boolean>;
  abstract getAccount({ account, authToken }: AuthData): Promise<VaultAccountWithAuth>;
  abstract checkPassword({ account, authToken }: AuthData): Promise<boolean>;
  abstract setMetadata({ account, metadata }: VaultAccount): Promise<void>;

  abstract set({ account, item, metadata: { type, iv }, cipher }: VaultItem): Promise<void>;
  abstract get({ account, item }: VaultKey): Promise<VaultData>;
  abstract fetchAll({ account }: Pick<VaultKey, 'account'>): Promise<VaultData[]>;

  abstract delete({ account, item }: VaultKey): Promise<void>;
}
