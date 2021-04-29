export interface VaultKey {
  account: string,
  individual: string,
}

export interface VaultData {
  iv: string,
  data: string,
}

export interface VaultItem extends VaultKey, VaultData {}

export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>;
  abstract connect(options?: T): BaseDriver<T>;

  abstract set({ account, individual, iv, data }: VaultItem): Promise<void>;

  abstract get({ account, individual }: VaultKey): Promise<VaultData>;
  abstract fetchAll({ account }: Pick<VaultKey, 'account'>): Promise<VaultData[]>;

  abstract delete({ account, individual }: VaultKey): Promise<void>;
  abstract deleteAll({ account }: Pick<VaultKey, 'account'>): Promise<void>;
}
