import z from 'zod'

import { CryptoResultSchema } from 'src/shared/schemas/crypto'
import { DEFAULT_CRYPTO_ITERATIONS } from './util'


export type CryptoResult = z.infer<typeof CryptoResultSchema>

function fromBytes(array: ArrayBuffer): string {
  const bytes = new Uint8Array(array)
  const chunkSize = 0x8000
  const chunks: string[] = []

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    chunks.push(String.fromCharCode(...chunk))
  }

  return btoa(chunks.join(''))
}

function toBytes(str: string): ArrayBuffer {
  const decoded = atob(str)
  const bytes = new Uint8Array(decoded.length)

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }

  return bytes.buffer
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
}

export async function deriveVaultKey({ password, salt, iterations }: InitialiseKeyParams): Promise<CryptoKey> {
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
      salt: enc.encode(salt),
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

export async function encryptBytesWithKey(key: CryptoKey, bytes: Uint8Array, kver?: string): Promise<CryptoResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const normalizedBytes = new Uint8Array(bytes.byteLength)
  normalizedBytes.set(bytes)
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    normalizedBytes,
  )

  return {
    iv: fromBytes(iv.buffer),
    cipher: fromBytes(cipher),
    kver,
  }
}

export async function decryptBytesWithKey(key: CryptoKey, payload: CryptoResult): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBytes(payload.iv) },
    key,
    toBytes(payload.cipher),
  )

  return new Uint8Array(plaintext)
}
