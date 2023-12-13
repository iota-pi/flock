import { AccountMetadata } from '../state/account';
import { ItemType } from '../state/items';
import { FlockPushSubscription } from '../utils/firebase-types';
import BaseAPI from './BaseAPI';
import { CryptoResult } from './Vault';
import env from '../env';


export interface VaultKey {
  item: string,
}

export interface VaultItem extends VaultKey {
  cipher: string,
  metadata: {
    type: ItemType,
    iv: string,
    modified: number,
  },
}

export type CachedVaultItem = Partial<VaultItem> & VaultKey;

export interface VaultAccount {
  account: string,
  metadata: Record<string, any>,
}

export interface VaultSubscription {
  subscription: FlockPushSubscription,
}


class VaultAPI extends BaseAPI {
  readonly endpoint = env.VAULT_ENDPOINT;

  async fetchAll({ cacheTime }: { cacheTime?: number | null }): Promise<VaultItem[]> {
    let url = `${this.endpoint}/${this.account}/items`;
    if (cacheTime) {
      url = `${url}?since=${cacheTime}`;
    }
    const result = await this.wrap(this.axios.get(url));
    return result.data.items;
  }

  async fetch({ item }: VaultKey): Promise<VaultItem> {
    const url = `${this.endpoint}/${this.account}/items/${item}`;
    const result = await this.wrap(this.axios.get(url));
    return result.data.items[0];
  }

  async put({ cipher, item, metadata }: VaultItem) {
    const url = `${this.endpoint}/${this.account}/items/${item}`;
    const result = await this.wrap(
      this.axios.put(url, { cipher, ...metadata }),
    );
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI put operation failed');
    }
  }

  async putMany({ items }: { items: VaultItem[] }) {
    const url = `${this.endpoint}/${this.account}/items`;
    const data = items.map(({ cipher, item, metadata }) => ({ cipher, id: item, ...metadata }));
    const result = await this.wrapMany(
      data,
      batch => this.axios.put(url, batch),
    );
    const success = result.filter(r => !r.data.success).length === 0;
    if (!success) {
      throw new Error('VaultAPI putMany operation failed');
    }
  }

  async delete({ item }: VaultKey) {
    const url = `${this.endpoint}/${this.account}/items/${item}`;
    const result = await this.wrap(this.axios.delete(url));
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI delete opteration failed');
    }
  }

  async deleteMany({ items }: & { items: string[] }) {
    const url = `${this.endpoint}/${this.account}/items`;
    const result = await this.wrapMany(
      items,
      batch => this.axios.delete(url, { data: batch }),
    );
    const success = result.filter(r => !r.data.success).length === 0;
    if (!success) {
      throw new Error('VaultAPI deleteMany opteration failed');
    }
  }

  async createAccount(): Promise<boolean> {
    const url = `${this.endpoint}/${this.account}`;
    const result = await this.wrap(this.axios.post(url, {})).catch(() => ({
      data: { success: false },
    }));
    return result.data.success as boolean;
  }

  async checkPassword() {
    const data = await this.getAccountData().catch(() => ({
      success: false,
    }));
    return data.success as boolean || false;
  }

  async getMetadata() {
    const data = await this.getAccountData();
    return data.metadata as (AccountMetadata | CryptoResult) || {};
  }

  private async getAccountData() {
    const url = `${this.endpoint}/${this.account}`;
    const result = await this.wrap(this.axios.get(url));
    return result.data;
  }

  async setMetadata({ metadata }: Pick<VaultAccount, 'metadata'>) {
    const url = `${this.endpoint}/${this.account}`;
    const result = await this.wrap(this.axios.patch(url, { metadata }));
    return result.data.success as boolean;
  }

  async setSubscription(
    {
      subscriptionId,
      subscription,
    }: VaultSubscription & { subscriptionId: string },
  ) {
    const url = `${this.endpoint}/${this.account}/subscriptions/${subscriptionId}`;
    const result = await this.wrap(this.axios.put(url, { ...subscription }));
    return result.data.success as boolean;
  }

  async deleteSubscription({ subscriptionId }: { subscriptionId: string }) {
    const url = `${this.endpoint}/${this.account}/subscriptions/${subscriptionId}`;
    const result = await this.wrap(this.axios.delete(url));
    return result.data.success as boolean;
  }

  async getSubscription({ subscriptionId }: { subscriptionId: string }) {
    const url = `${this.endpoint}/${this.account}/subscriptions/${subscriptionId}`;
    const result = await this.wrap(this.axios.get(url));
    if (!result.data.success) {
      throw new Error(`Could not get subscription info from server: ${subscriptionId}`);
    }
    return result.data.subscription as FlockPushSubscription | null;
  }
}

export default VaultAPI;
