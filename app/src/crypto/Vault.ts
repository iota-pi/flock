import VaultAPI from './api';
import crypto from './_crypto';
import { TextEncoder, TextDecoder } from './_util';
import { Item } from '../state/items';

const api = new VaultAPI();

function fromBytes(array: ArrayBuffer): string {
  const byteArray = Array.from(new Uint8Array(array));
  const asString = byteArray.map(b => String.fromCharCode(b)).join('');
  return btoa(asString);
}

function toBytes(str: string): Uint8Array {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
}

export interface CryptoResult {
  iv: string,
  cipher: string,
}

class Vault<T extends Item = Item> {
  private account: string;
  private keyHash: string;
  private key: CryptoKey;

  constructor(account: string, key: CryptoKey, keyHash: string) {
    this.account = account;
    this.key = key;
    this.keyHash = keyHash;
  }

  static async create(accountId: string, password: string) {
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
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyBase,
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
    const keyBuffer = await crypto.subtle.exportKey('raw', key);
    const keyHash = await crypto.subtle.digest('SHA-512', keyBuffer);
    return new Vault(accountId, key, fromBytes(keyHash));
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

  encryptObject(obj: T) {
    return this.encrypt(JSON.stringify(obj));
  }

  async decryptObject({ iv, cipher }: CryptoResult): Promise<T> {
    return JSON.parse(await this.decrypt({ iv, cipher }));
  }

  async store(item: T) {
    const { cipher, iv } = await this.encryptObject(item);
    await api.put({
      account: this.account,
      item: item.id,
      cipher,
      iv,
      authToken: this.keyHash,
    });
  }

  async fetch(item: string) {
    const result = await api.fetch({
      account: this.account,
      item,
    });
    return this.decryptObject(result);
  }

  async fetchAll() {
    const result = await api.fetchAll({
      account: this.account,
    });
    return Promise.all(result.map(d => this.decryptObject(d)));
  }
}

export default Vault;

let globalVault: Vault | undefined;
export function registerVault(vault: Vault) {
  globalVault = vault;
}

export function useVault() {
  return globalVault;
}
