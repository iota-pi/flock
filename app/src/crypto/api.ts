import axios from 'axios';
import { CryptoResult } from '.';


export interface VaultKey {
  account: string,
  individual: string,
}

export interface VaultItem extends VaultKey, CryptoResult {}


class VaultAPI {
  readonly endpoint = process.env.VUE_APP_VAULT_ENDPOINT!;

  async fetchAll({ account }: Pick<VaultKey, 'account'>): Promise<CryptoResult[]> {
    const url = `${this.endpoint}/${account}/individuals`;
    const result = await axios.get(url);
    return result.data.individuals;
  }

  async fetch({ account, individual }: VaultKey): Promise<CryptoResult> {
    const url = `${this.endpoint}/${account}/individuals/${individual}`;
    const result = await axios.get(url);
    return result.data.individuals[0];
  }

  async put({ account, individual, cipher, iv }: VaultItem) {
    const url = `${this.endpoint}/${account}/individuals/${individual}`;
    const result = await axios.put(url, { cipher, iv });
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI put operation was not successful');
    }
  }
}

export default VaultAPI;
