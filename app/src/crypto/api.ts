import { Individual } from '@/utils/interfaces';
import axios from 'axios';


export interface VaultKey {
  account: string,
  individual: string,
}

export interface VaultItem extends VaultKey {
  data: string,
  iv: string,
}


class VaultAPI {
  readonly endpoint = process.env.VUE_APP_VAULT_ENDPOINT!;

  async fetchAll({ account }: Pick<VaultKey, 'account'>): Promise<Individual[]> {
    const url = `${this.endpoint}/${account}/individuals`;
    const result = await axios.get(url);
    return result.data.individuals;
  }

  async fetch({ account, individual }: VaultKey): Promise<Individual[]> {
    const url = `${this.endpoint}/${account}/individuals/${individual}`;
    const result = await axios.get(url);
    return result.data.individuals[0];
  }

  async put({ account, individual, data, iv }: VaultItem) {
    console.log((await axios.get(`${this.endpoint}`)).data);
    const url = `${this.endpoint}/${account}/individuals/${individual}`;
    const result = await axios.put(url, { data, iv });
    const success = result.data.success || false;
    if (!success) {
      throw new Error('VaultAPI put operation was not successful');
    }
  }
}

export default VaultAPI;
