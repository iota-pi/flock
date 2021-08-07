import axios, { AxiosRequestConfig } from 'axios';
import { AccountMetadata } from '../state/account';
import { ItemType } from '../state/items';
import { finishRequest, startRequest } from '../state/ui';
import { AppDispatch } from '../store';
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
  account: string,
  authToken: string,
}

export interface VaultAccount {
  account: string,
  metadata: Record<string, any>,
}


class VaultAPI {
  readonly endpoint = process.env.REACT_APP_VAULT_ENDPOINT!;
  dispatch: AppDispatch | undefined;

  constructor(dispatch?: AppDispatch) {
    this.dispatch = dispatch;
  }

  private startRequest() {
    if (this.dispatch) {
      this.dispatch(startRequest());
    }
  }

  private finishRequest(error?: string) {
    if (this.dispatch) {
      this.dispatch(finishRequest(error));
    }
  }

  private async wrap<T>(promise: Promise<T>): Promise<T> {
    this.startRequest();
    try {
      const result = await promise;
      this.finishRequest();
      return result;
    } catch (error) {
      this.finishRequest('A request to the server failed. Please retry later.');
      throw error;
    }
  }

  private getAuth(authToken: string): AxiosRequestConfig {
    return {
      headers: { Authorization: `Basic ${authToken}` },
    };
  }

  async fetchAll({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth): Promise<VaultItem[]> {
    const url = `${this.endpoint}/${account}/items`;
    const result = await this.wrap(axios.get(url, this.getAuth(authToken)));
    return result.data.items;
  }

  async fetch({ account, authToken, item }: VaultKey & VaultAuth): Promise<VaultItem> {
    const url = `${this.endpoint}/${account}/items/${item}`;
    const result = await this.wrap(axios.get(url, this.getAuth(authToken)));
    return result.data.items[0];
  }

  async put({ account, authToken, cipher, item, metadata }: VaultItem & VaultAuth) {
    const url = `${this.endpoint}/${account}/items/${item}`;
    const result = await this.wrap(
      axios.put(url, { cipher, ...metadata }, this.getAuth(authToken)),
    );
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI put operation failed');
    }
  }

  async putMany({ account, authToken, items }: VaultAuth & { items: VaultItem[] }) {
    const url = `${this.endpoint}/${account}/items`;
    const data = items.map(({ cipher, item, metadata }) => ({ cipher, id: item, ...metadata }));
    const result = await this.wrap(axios.put(url, data, this.getAuth(authToken)));
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI put operation failed');
    }
  }

  async delete({ account, authToken, item }: VaultKey & VaultAuth) {
    const url = `${this.endpoint}/${account}/items/${item}`;
    const result = await this.wrap(axios.delete(url, this.getAuth(authToken)));
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI delete opteration failed');
    }
  }

  async deleteMany({ account, authToken, items }: VaultAuth & { items: string[] }) {
    const url = `${this.endpoint}/${account}/items`;
    const result = await this.wrap(axios.delete(url, { ...this.getAuth(authToken), data: items }));
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI deleteMany opteration failed');
    }
  }

  async createAccount({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth): Promise<boolean> {
    const url = `${this.endpoint}/${account}`;
    const result = await this.wrap(axios.post(url, {}, this.getAuth(authToken)));
    return result.data.success as boolean;
  }

  private async getAccountData({ account, authToken }: Pick<VaultKey, 'account'> & VaultAuth) {
    const url = `${this.endpoint}/${account}`;
    const result = await this.wrap(axios.get(url, this.getAuth(authToken)));
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
    const result = await this.wrap(axios.patch(url, { metadata }, this.getAuth(authToken)));
    return result.data.success as boolean;
  }
}

export default VaultAPI;
