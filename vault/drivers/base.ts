export type VaultItemType = 'person' | 'group';

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
  authToken: string,
}

export interface VaultItem extends VaultKey, VaultData {}

export function asItemType(type: string): VaultItemType {
  if (['person', 'group'].includes(type)) {
    return type as VaultItemType;
  }
  throw new Error(`Item type ${type} is not valid`);
}

export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>;
  abstract connect(options?: T): BaseDriver<T>;

  abstract createAccount({ authToken }: Pick<AuthData, 'authToken'>): Promise<boolean>;
  abstract checkPassword({ account, authToken }: AuthData): Promise<boolean>;

  abstract set({ account, item, metadata: { type, iv }, cipher }: VaultItem): Promise<void>;
  abstract get({ account, item }: VaultKey): Promise<VaultData>;
  abstract fetchAll({ account }: Pick<VaultKey, 'account'>): Promise<VaultData[]>;

  abstract delete({ account, item }: VaultKey): Promise<void>;
  abstract deleteAll({ account }: Pick<VaultKey, 'account'>): Promise<void>;
}
