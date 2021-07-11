import axios, { AxiosRequestConfig } from 'axios';
import { AccountMetadata } from '../state/account';
import { ItemType } from '../state/items';
import { CryptoResult } from './Vault';


export interface VaultKey {
  account: string,
  item: string,
}

export interface VaultItem extends VaultKey {
  cipher: string,
  metadata: {
    type: ItemType,
    iv: string,
  },
}

export interface VaultAuth {
  authToken: string,
}

export interface VaultAccount {
  account: string,
  metadata: Record<string, any>,
}


class VaultAPI {
  readonly endpoint = process.env.REACT_APP_VAULT_ENDPOINT!;

  private getAuthorization(authToken: string): AxiosRequestConfig {
    return {
      headers: { Authorization: `Basic ${authToken}` },
    };
  }

  async fetchAll({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth): Promise<VaultItem[]> {
    const url = `${this.endpoint}/${account}/items`;
    const result = await axios.get(url, this.getAuthorization(authToken));
    return result.data.items;
  }

  async fetch({ account, authToken, item }: VaultKey & VaultAuth): Promise<VaultItem> {
    const url = `${this.endpoint}/${account}/items/${item}`;
    const result = await axios.get(url, this.getAuthorization(authToken));
    return result.data.items[0];
  }

  async put({ account, authToken, cipher, item, metadata }: VaultItem & VaultAuth) {
    const url = `${this.endpoint}/${account}/items/${item}`;
    const result = await axios.put(url, { cipher, ...metadata }, this.getAuthorization(authToken));
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI put operation failed');
    }
  }

  async delete({ account, authToken, item }: VaultKey & VaultAuth) {
    const url = `${this.endpoint}/${account}/items/${item}`;
    const result = await axios.delete(url, this.getAuthorization(authToken));
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI delete opteration failed');
    }
  }

  async createAccount({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth): Promise<boolean> {
    const url = `${this.endpoint}/${account}`;
    const result = await axios.post(url, {}, this.getAuthorization(authToken));
    return result.data.success as boolean;
  }

  private async getAccountData({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth) {
    const url = `${this.endpoint}/${account}`;
    const result = await axios.get(url, this.getAuthorization(authToken));
    return result.data;
  }

  async getMetadata({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth) {
    const data = await this.getAccountData({ account, authToken });
    return data.metadata as (AccountMetadata | CryptoResult) || {};
  }

  async checkPassword({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth) {
    const data = await this.getAccountData({ account, authToken });
    return data.success as boolean || false;
  }

  async setMetadata({ account, authToken, metadata }: VaultAccount & VaultAuth) {
    const url = `${this.endpoint}/${account}`;
    const result = await axios.patch(url, { metadata }, this.getAuthorization(authToken));
    return result.data.success as boolean;
  }
}

export default VaultAPI;
