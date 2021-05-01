import crypto from './_crypto';
import VaultAPI from './api';
import { Individual } from '@/utils/interfaces';

const api = new VaultAPI();

export interface CryptoResult {
  iv: string,
  cipher: string,
}

export class Vault<T extends Individual = Individual> {
  private account: string;
  private key: CryptoKey;

  constructor(account: string, key: CryptoKey) {
    this.account = account;
    this.key = key;
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
      false,
      ['encrypt', 'decrypt'],
    );
    return new Vault(accountId, key);
  }

  private fromBytes(array: ArrayBuffer): string {
    const byteArray = Array.from(new Uint8Array(array));
    const asString = byteArray.map(b => String.fromCharCode(b)).join('');
    return btoa(asString);
  }

  private toBytes(str: string): Uint8Array {
    return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)));
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
      iv: this.fromBytes(iv),
      cipher: this.fromBytes(cipher),
    };
  }

  async decrypt(
    {
      iv,
      cipher,
    }: CryptoResult,
  ): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.toBytes(iv) },
      this.key,
      this.toBytes(cipher)
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

  async store(individual: T) {
    const { cipher, iv } = await this.encryptObject(individual);
    await api.put({
      account: this.account,
      individual: individual.id,
      cipher,
      iv,
    });
  }

  async fetch(individual: string) {
    const result = await api.fetch({
      account: this.account,
      individual,
    });
    return await this.decryptObject(result);
  }

  async fetchAll() {
    const result = await api.fetchAll({
      account: this.account,
    });
    return await Promise.all(result.map(d => this.decryptObject(d)));
  }
}
