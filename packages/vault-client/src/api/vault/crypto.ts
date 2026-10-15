import { z } from 'zod'

import { CryptoResultSchema, DOC_BOUND_FORMAT } from '@vault/shared/crypto'
import { DEFAULT_CRYPTO_ITERATIONS } from './util'


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

type InitialiseKeyParams = {
  password: string,
  salt: string,
  iterations?: number,
  saltVersion?: number,
  /** Decodes salts from before `saltVersion` 1. Without it, such salts are rejected. */
  decodeLegacySalt?: (salt: string) => ArrayBuffer,
}

export const CURRENT_SALT_VERSION = 1

export class UnsupportedKeyDerivationError extends Error {
  constructor(saltVersion: number | undefined) {
    super(`Unsupported salt version: ${saltVersion ?? 'none'}`)
    this.name = 'UnsupportedKeyDerivationError'
  }
}

function decodeSalt({ salt, saltVersion, decodeLegacySalt }: InitialiseKeyParams): ArrayBuffer {
  if (saltVersion === CURRENT_SALT_VERSION) {
    return toBytes(salt)
  }
  if (decodeLegacySalt) {
    return decodeLegacySalt(salt)
  }
  throw new UnsupportedKeyDerivationError(saltVersion)
}

export async function deriveVaultKey(params: InitialiseKeyParams): Promise<CryptoKey> {
  const { password, iterations } = params
  const enc = new TextEncoder()
  const keyBase = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey'],
  )

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: decodeSalt(params),
      iterations: iterations || DEFAULT_CRYPTO_ITERATIONS,
      hash: 'SHA-256',
    },
    keyBase,
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
