import VaultAPI, { CachedVaultItem, VaultItem } from './VaultAPI';
import crypto from './_crypto';
import { TextEncoder, TextDecoder } from './_util';
import { checkProperties, deleteItems, Item, setItems, updateItems } from '../state/items';
import { AccountMetadata, AccountState, setAccount } from '../state/account';
import { AppDispatch } from '../store';
import { FlockPushSubscription } from '../utils/firebase-types';
import KoinoniaAPI from './KoinoniaAPI';


const VAULT_ITEM_CACHE = 'vaultItemCache';
const VAULT_ITEM_CACHE_TIME = 'vaultItemCacheTime';

function fromBytes(array: ArrayBuffer): string {
  const byteArray = Array.from(new Uint8Array(array));
  const asString = byteArray.map(b => String.fromCharCode(b)).join('');
  return btoa(asString);
}

function fromBytesUrlSafe(array: ArrayBuffer): string {
  return fromBytes(array).replace(/\//g, '_').replace(/\+/g, '-');
}

function toBytes(str: string): Uint8Array {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
}

export interface CryptoResult {
  iv: string,
  cipher: string,
}

export interface VaultImportExportData {
  account: string,
  key: string,
}

export interface VaultConstructorData {
  account: string,
  dispatch: AppDispatch,
  key: CryptoKey,
  keyHash: string,
}

class Vault {
  private account: string;
  readonly api: VaultAPI;
  private dispatch: AppDispatch;
  private key: CryptoKey;
  private keyHash: string;
  readonly koinonia: KoinoniaAPI;

  constructor({ account, dispatch, key, keyHash }: VaultConstructorData) {
    this.account = account;
    this.api = new VaultAPI(account, keyHash, dispatch);
    this.dispatch = dispatch;
    this.key = key;
    this.keyHash = keyHash;
    this.koinonia = new KoinoniaAPI(account, keyHash, dispatch);
  }

  static async create(
    accountId: string,
    password: string,
    dispatch: AppDispatch,
    iterations?: number,
  ) {
    const enc = new TextEncoder();
    const keyBase = await crypto.subtle.importKey(
      'raw',
      enc.encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: enc.encode(accountId),
        iterations: iterations || 100000,
        hash: 'SHA-256',
      },
      keyBase,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const keyBuffer = await crypto.subtle.exportKey('raw', key);
    const keyHash = await crypto.subtle.digest('SHA-512', keyBuffer);
    return new Vault({
      account: accountId,
      dispatch,
      key,
      keyHash: fromBytes(keyHash),
    });
  }

  static async import(data: VaultImportExportData, dispatch: AppDispatch): Promise<Vault> {
    const account = data.account;
    const key = await crypto.subtle.importKey(
      'raw',
      toBytes(data.key),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const keyBuffer = await crypto.subtle.exportKey('raw', key);
    const keyHash = await crypto.subtle.digest('SHA-512', keyBuffer);
    return new Vault({
      account,
      dispatch,
      key,
      keyHash: fromBytes(keyHash),
    });
  }

  async export(): Promise<VaultImportExportData> {
    return {
      account: this.account,
      key: fromBytes(await crypto.subtle.exportKey('raw', this.key)),
    };
  }

  get authToken() {
    return this.keyHash;
  }

  async encrypt(plaintext: string): Promise<CryptoResult> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.key,
      enc.encode(plaintext),
    );
    return {
      iv: fromBytes(iv),
      cipher: fromBytes(cipher),
    };
  }

  async decrypt(
    {
      iv,
      cipher,
    }: CryptoResult,
  ): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toBytes(iv) },
      this.key,
      toBytes(cipher),
    );
    const dec = new TextDecoder();
    return dec.decode(plaintext);
  }

  encryptObject(obj: Record<string, any>) {
    return this.encrypt(JSON.stringify(obj));
  }

  async decryptObject({ iv, cipher }: CryptoResult): Promise<Record<string, any>> {
    return JSON.parse(await this.decrypt({ iv, cipher }));
  }

  exportData(items: Item[]): Promise<CryptoResult> {
    const data = JSON.stringify(items);
    return this.encrypt(data);
  }

  async importData(data: CryptoResult): Promise<Item[]> {
    const plainData = await this.decrypt(data);
    return JSON.parse(plainData);
  }

  store(data: Item | Item[]) {
    if (data instanceof Array) {
      return this.storeMany(data);
    }
    return this.storeOne(data);
  }

  private async storeOne(item: Item) {
    const checkResult = checkProperties([item]);
    if (checkResult.error) {
      throw new Error(checkResult.message);
    }

    this.dispatch(updateItems([item], true));
    const { cipher, iv } = await this.encryptObject(item);
    await this.api.put({
      cipher,
      item: item.id,
      metadata: {
        iv,
        type: item.type,
        modified: new Date().getTime(),
      },
    });
  }

  private async storeMany(items: Item[]) {
    const checkResult = checkProperties(items);
    if (checkResult.error) {
      throw new Error(checkResult.message);
    }

    this.dispatch(updateItems(items, true));
    const encrypted = await Promise.all(
      items.map(
        item => this.encryptObject(item),
      ),
    );
    const modifiedTime = new Date().getTime();

    await this.api.putMany({
      items: encrypted.map(({ cipher, iv }, i) => ({
        account: this.account,
        cipher,
        item: items[i].id,
        metadata: {
          iv,
          type: items[i].type,
          modified: modifiedTime,
        },
      })),
    });
  }

  private getItemCacheTime() {
    const raw = localStorage.getItem(VAULT_ITEM_CACHE_TIME);
    if (raw) {
      return parseInt(raw);
    }
    return null;
  }

  private async mergeWithItemCache(itemsPromise: Promise<CachedVaultItem[]>): Promise<VaultItem[]> {
    const rawCache = localStorage.getItem(VAULT_ITEM_CACHE);
    if (rawCache) {
      const cachedItems: VaultItem[] = JSON.parse(rawCache);
      const cachedMap = new Map(cachedItems.map(item => [item.item, item]));
      const items = await itemsPromise;
      const result = items.map(
        item => (item.cipher ? (item as VaultItem) : cachedMap.get(item.item)),
      );
      const filteredResult = result.filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      );
      if (filteredResult.length !== result.length) {
        console.warn('Some items were missing from the cache!');
      } else {
        this.setItemCache(filteredResult);
      }
      return filteredResult;
    }
    const items = await itemsPromise;
    if (items.find(item => !item.cipher)) {
      console.warn('Some items were missing from the cache!');
    } else {
      this.setItemCache(items as VaultItem[]);
    }
    return items as VaultItem[];
  }

  private setItemCache(items: VaultItem[]) {
    const raw = JSON.stringify(items);
    localStorage.setItem(VAULT_ITEM_CACHE, raw);
    localStorage.setItem(VAULT_ITEM_CACHE_TIME, new Date().getTime().toString());
  }

  clearItemCache() {
    localStorage.removeItem(VAULT_ITEM_CACHE);
    localStorage.removeItem(VAULT_ITEM_CACHE_TIME);
  }

  checkItemCache() {
    return !!localStorage.getItem(VAULT_ITEM_CACHE_TIME);
  }

  async fetchAll(): Promise<Item[]> {
    const cacheTime = this.getItemCacheTime();
    const fetchPromise = this.api.fetchAll({
      cacheTime,
    });
    const mergedFetch = await this.mergeWithItemCache(fetchPromise);
    const resultPromise = Promise.all(mergedFetch.map(
      item => this.decryptObject({
        cipher: item.cipher,
        iv: item.metadata.iv,
      }) as Promise<Item>,
    ));
    resultPromise.then(items => this.dispatch(setItems(items)));
    return resultPromise;
  }

  delete(data: string | string[]) {
    if (data instanceof Array) {
      return this.deleteMany(data);
    }
    return this.deleteOne(data);
  }

  private async deleteOne(itemId: string) {
    this.dispatch(deleteItems([itemId], true));
    try {
      await this.api.delete({
        item: itemId,
      });
    } catch (error) {
      return false;
    }
    return true;
  }

  private async deleteMany(itemIds: string[]) {
    this.dispatch(deleteItems(itemIds, true));
    try {
      await this.api.deleteMany({
        items: itemIds,
      });
    } catch (error) {
      return false;
    }
    return true;
  }

  async setMetadata(metadata: AccountMetadata) {
    this.dispatch(setAccount({ metadata }));
    const { cipher, iv } = await this.encryptObject(metadata);
    return this.api.setMetadata({
      metadata: { cipher, iv },
    });
  }

  async getMetadata(): Promise<AccountState> {
    const result = await this.api.getMetadata();
    let metadata: AccountMetadata;
    try {
      metadata = await this.decryptObject(result as CryptoResult);
    } catch (error) {
      // Backwards compatibility (10/07/21)
      metadata = result as AccountMetadata;
    }
    const accountData: AccountState = { account: this.account, metadata };
    this.dispatch(setAccount(accountData));
    return accountData;
  }

  private async getSubscriptionId(subscriptionToken: string): Promise<string> {
    const buffer = await crypto.subtle.digest('SHA-512', Buffer.from(subscriptionToken));
    return fromBytesUrlSafe(buffer);
  }

  async getSubscription(subscriptionToken: string): Promise<FlockPushSubscription | null> {
    const result = await this.api.getSubscription({
      subscriptionId: await this.getSubscriptionId(subscriptionToken),
    });
    return result;
  }

  async setSubscription(subscription: FlockPushSubscription): Promise<void> {
    const result = await this.api.setSubscription({
      subscriptionId: await this.getSubscriptionId(subscription.token),
      subscription,
    });
    if (!result) {
      throw new Error('Failed to save push notification token to server');
    }
  }

  async deleteSubscription(subscriptionToken: string): Promise<void> {
    const result = await this.api.deleteSubscription({
      subscriptionId: await this.getSubscriptionId(subscriptionToken),
    });
    if (!result) {
      throw new Error('Failed to delete push notification token from server');
    }
  }
}

export default Vault;
