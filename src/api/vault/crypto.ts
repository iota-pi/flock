import * as Automerge from '@automerge/automerge'

export interface CryptoResult {
  iv: string,
  cipher: string,
}

export function fromBytes(array: ArrayBuffer): string {
  const byteArray = Array.from(new Uint8Array(array))
  const asString = byteArray.map(b => String.fromCharCode(b)).join('')
  return btoa(asString)
}

export function toBytes(str: string): ArrayBuffer {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))).buffer
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

function createVersionId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
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
      iterations: iterations || 100000,
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

export async function encryptWithKey(key: CryptoKey, plaintext: string): Promise<CryptoResult> {
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

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(item => stripUndefinedDeep(item))
      .filter(item => item !== undefined)
  }

  if (value && typeof value === 'object') {
    if (
      value instanceof Date
      || value instanceof Uint8Array
      || value instanceof ArrayBuffer
    ) {
      return value
    }

    const cleanedEntries = Object.entries(value as Record<string, unknown>)
      .flatMap(([entryKey, nestedValue]) => {
        if (nestedValue === undefined) {
          return []
        }

        return [[entryKey, stripUndefinedDeep(nestedValue)] as const]
      })

    return Object.fromEntries(cleanedEntries)
  }

  return value
}

export async function encryptObjectAsAutomergeWithKey(
  key: CryptoKey,
  obj: object,
): Promise<{ encryptedAutomergeDoc: string, versionId: string }> {
  const cleanedObject = stripUndefinedDeep(obj) as Record<string, unknown>
  const doc = Automerge.from(cleanedObject)
  const binary = Automerge.save(doc)

  const iv = crypto.getRandomValues(new Uint8Array(16))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    binary as BufferSource,
  )

  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
  const ctHex = Array.from(new Uint8Array(cipher)).map(b => b.toString(16).padStart(2, '0')).join('')

  return {
    encryptedAutomergeDoc: ivHex + ctHex,
    versionId: createVersionId(),
  }
}
