export interface CryptoResult {
  iv: Uint8Array,
  cipher: ArrayBuffer,
}

export class Vault {
  private key: CryptoKey;

  constructor(key: CryptoKey) {
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
    return new Vault(key);
  }

  async encrypt(plaintext: string): Promise<CryptoResult> {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const enc = new TextEncoder();
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      this.key,
      enc.encode(plaintext),
    );
    return { iv, cipher };
  }

  async decrypt(
    {
      iv,
      cipher,
    }: CryptoResult,
  ): Promise<string> {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      this.key,
      cipher,
    );
    const dec = new TextDecoder();
    return dec.decode(plaintext);
  }

  encryptObject(obj: Record<string, unknown>) {
    return this.encrypt(JSON.stringify(obj));
  }

  async decryptObject({ iv, cipher, }: CryptoResult) {
    return JSON.parse(await this.decrypt({ iv, cipher }));
  }
}
