import axios, { AxiosRequestConfig } from 'axios';
import { ItemType } from '../state/items';


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


class VaultAPI {
  readonly endpoint = process.env.REACT_APP_VAULT_ENDPOINT!;

  private getAuthorization(authToken: string): AxiosRequestConfig {
    return {
      headers: { Authorization: `Basic ${authToken}` },
    };
  }

  async fetchAll({ account }: Pick<VaultKey, 'account'>): Promise<VaultItem[]> {
    const url = `${this.endpoint}/${account}/items`;
    const result = await axios.get(url);
    return result.data.items;
  }

  async fetch({ account, item }: VaultKey): Promise<VaultItem> {
    const url = `${this.endpoint}/${account}/items/${item}`;
    const result = await axios.get(url);
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

  async checkPassword({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth) {
    const url = `${this.endpoint}/${account}/auth`;
    const result = await axios.get(url, this.getAuthorization(authToken));
    return result.data.success as boolean || false;
  }
}

export default VaultAPI;
