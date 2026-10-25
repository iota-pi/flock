import { z } from 'zod'

import { CryptoResultSchema, DOC_BOUND_FORMAT } from '@vault/shared'
import {
  assertKdfAcceptable,
  assertPbkdf2Acceptable,
  deriveArgon2idBytes,
  getDefaultPbkdf2Iterations,
  UnsupportedKeyDerivationError,
  type KdfParams,
} from './kdf'

export { UnsupportedKeyDerivationError }


export type CryptoResult = z.infer<typeof CryptoResultSchema>

function fromBytes(array: ArrayBuffer): string {
  return new Uint8Array(array).toBase64()
}

function toBytes(str: string): ArrayBuffer {
  return Uint8Array.fromBase64(str).buffer
}

export function generateSalt(): string {
  const saltArray = new Uint8Array(16)
  crypto.getRandomValues(saltArray)
  return fromBytes(saltArray.buffer)
}

/**
 * Derives the 32-byte PBKDF2-SHA256 key of an account without Argon2id parameters. The app
 * provides it while such accounts still log in (see `VaultHostHooks.deriveLegacyKey`).
 */
export type DeriveLegacyKey = (params: { password: string, salt: ArrayBuffer, iterations: number }) => Promise<ArrayBuffer>

type InitialiseKeyParams = {
  password: string,
  salt: string,
  /** Argon2id parameters. Without them, the key is derived with PBKDF2 through `deriveLegacyKey`. */
  kdf?: KdfParams,
  iterations?: number,
  saltVersion?: number,
  /** Decodes salts from before `saltVersion` 1. Without it, such salts are rejected. */
  decodeLegacySalt?: (salt: string) => ArrayBuffer,
  /** Derives PBKDF2 keys. Without it, accounts without `kdf` are rejected. */
  deriveLegacyKey?: DeriveLegacyKey,
}

export const CURRENT_SALT_VERSION = 1

function decodeSalt({ salt, saltVersion, decodeLegacySalt }: InitialiseKeyParams): ArrayBuffer {
  if (saltVersion === CURRENT_SALT_VERSION) {
    return toBytes(salt)
  }
  if (decodeLegacySalt) {
    return decodeLegacySalt(salt)
  }
  throw new UnsupportedKeyDerivationError(saltVersion)
}

/**
 * Derives an account's master key from its password. The parameters come from the server or local
 * metadata, so they're checked against `getKdfLimits()` first.
 */
export async function deriveVaultKey(params: InitialiseKeyParams): Promise<CryptoKey> {
  const { password, kdf, deriveLegacyKey } = params
  const salt = decodeSalt(params)
  let keyBytes: ArrayBuffer | Uint8Array<ArrayBuffer>
  if (kdf) {
    assertKdfAcceptable(kdf)
    keyBytes = await deriveArgon2idBytes(password, new Uint8Array(salt), kdf) as Uint8Array<ArrayBuffer>
  } else {
    const iterations = params.iterations || getDefaultPbkdf2Iterations()
    assertPbkdf2Acceptable(iterations)
    if (!deriveLegacyKey) {
      throw new UnsupportedKeyDerivationError('This app no longer derives PBKDF2 keys')
    }
    keyBytes = await deriveLegacyKey({ password, salt, iterations })
  }

  return crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

export async function importVaultKey(rawKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toBytes(rawKey),
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

export async function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

export async function exportVaultKey(key: CryptoKey): Promise<string> {
  return fromBytes(await crypto.subtle.exportKey('raw', key))
}

export async function hashVaultKey(key: CryptoKey): Promise<string> {
  const keyBuffer = await crypto.subtle.exportKey('raw', key)
  const keyHashBytes = await crypto.subtle.digest('SHA-512', keyBuffer)
  return fromBytes(keyHashBytes)
}


export async function encryptWithKey(key: CryptoKey, plaintext: string, kver?: string): Promise<CryptoResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plaintext),
  )

  return {
    iv: fromBytes(iv.buffer),
    cipher: fromBytes(cipher),
    kver,
  }
}

export async function decryptWithKey(key: CryptoKey, payload: CryptoResult): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBytes(payload.iv) },
    key,
    toBytes(payload.cipher),
  )

  return new TextDecoder().decode(plaintext)
}

function docAssociatedData(docId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`vault-doc:${docId}`)
}

/**
 * Encrypts bytes. With a `docId`, the ciphertext is bound to that document and only decrypts when
 * the same `docId` is given.
 */
export async function encryptBytesWithKey(
  key: CryptoKey,
  bytes: Uint8Array,
  kver?: string,
  docId?: string,
): Promise<CryptoResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const normalizedBytes = new Uint8Array(bytes.byteLength)
  normalizedBytes.set(bytes)
  const cipher = await crypto.subtle.encrypt(
    docId === undefined
      ? { name: 'AES-GCM', iv }
      : { name: 'AES-GCM', iv, additionalData: docAssociatedData(docId) },
    key,
    normalizedBytes,
  )

  return {
    iv: fromBytes(iv.buffer),
    cipher: fromBytes(cipher),
    kver,
    ...(docId === undefined ? {} : { format: DOC_BOUND_FORMAT }),
  }
}

/**
 * Decrypts bytes. A doc-bound ciphertext needs the `docId` it was written for. Unbound ciphertexts
 * written before binding still decrypt.
 */
export async function decryptBytesWithKey(
  key: CryptoKey,
  payload: CryptoResult,
  docId?: string,
): Promise<Uint8Array> {
  let additionalData: Uint8Array<ArrayBuffer> | undefined
  if (payload.format === DOC_BOUND_FORMAT) {
    if (docId === undefined) {
      throw new Error('A doc-bound ciphertext needs its document ID to decrypt')
    }
    additionalData = docAssociatedData(docId)
  } else if (payload.format !== undefined) {
    throw new Error(`Unsupported ciphertext format ${String(payload.format)}`)
  }

  const plaintext = await crypto.subtle.decrypt(
    additionalData
      ? { name: 'AES-GCM', iv: toBytes(payload.iv), additionalData }
      : { name: 'AES-GCM', iv: toBytes(payload.iv) },
    key,
    toBytes(payload.cipher),
  )

  return new Uint8Array(plaintext)
}

/** AES-GCM ciphertext with its IV, as raw bytes */
export interface SealedBytes {
  iv: Uint8Array<ArrayBuffer>
  ct: Uint8Array<ArrayBuffer>
}

function copyToArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

/** Encrypts bytes with a fresh 96-bit IV, bound to `associatedData` */
export async function encryptWithAssociatedData(
  key: CryptoKey,
  bytes: Uint8Array,
  associatedData: Uint8Array,
): Promise<SealedBytes> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: copyToArrayBuffer(associatedData) },
    key,
    copyToArrayBuffer(bytes),
  )
  return { iv, ct: new Uint8Array(ct) }
}

/** Decrypts bytes from `encryptWithAssociatedData`. Throws unless `associatedData` matches. */
export async function decryptWithAssociatedData(
  key: CryptoKey,
  sealed: { iv: Uint8Array, ct: Uint8Array },
  associatedData: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copyToArrayBuffer(sealed.iv), additionalData: copyToArrayBuffer(associatedData) },
    key,
    copyToArrayBuffer(sealed.ct),
  )
  return new Uint8Array(plaintext)
}
