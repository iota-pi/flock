import { DEVICE_TOKEN_LENGTH } from '@vault/shared'
import { getVaultStorageNames } from '../shared/storageNames'
import { decryptWithAssociatedData, encryptWithAssociatedData } from './crypto'

/*
 * A device token is a random secret this device sends with every login. Once the server has seen it
 * with the right password, the right password from this device gets in even while the account is
 * locked by someone else's failed logins.
 *
 * It's stored sealed with a key derived from the auth token (the hash of the master key), so a copy
 * of local storage can't use it without the password. That also means this device only sends its
 * token with a password that opened it. The server takes the token arriving with a wrong password
 * as a sign it was stolen, and forgets it.
 */

interface StoredDeviceToken {
  account: string
  iv: string
  ct: string
}

export interface DeviceToken {
  token: string
  /** Whether the token was already stored, rather than made for this login */
  stored: boolean
}

const HKDF_INFO = new TextEncoder().encode('vault-login-device-token')

function associatedData(account: string): Uint8Array {
  return new TextEncoder().encode(`vault-login-device:${account}`)
}

async function sealingKey(keyHash: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', Uint8Array.fromBase64(keyHash), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: HKDF_INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function readStored(): StoredDeviceToken | undefined {
  if (typeof localStorage === 'undefined') return undefined
  const serialized = localStorage.getItem(getVaultStorageNames().loginDeviceKey)
  if (!serialized) return undefined
  try {
    const parsed = JSON.parse(serialized) as Partial<StoredDeviceToken>
    if (typeof parsed.account === 'string' && typeof parsed.iv === 'string' && typeof parsed.ct === 'string') {
      return parsed as StoredDeviceToken
    }
  } catch {
    // Unreadable: a new token replaces it
  }
  return undefined
}

/** 32 random bytes as unpadded base64url */
export function generateDeviceToken(): string {
  return crypto.getRandomValues(new Uint8Array(32)).toBase64({ alphabet: 'base64url', omitPadding: true })
}

/**
 * The device token to log in to `account` with. The stored one if `keyHash` opens it, or else a new
 * one, which `rememberDeviceToken` stores once a login with it gets through.
 *
 * Failing to open the stored token isn't an error, unlike sealed user content: it's how this tells
 * that the password was wrong or has changed, and the token is only ever replaced, never read wrong.
 */
export async function loadDeviceToken(account: string, keyHash: string): Promise<DeviceToken> {
  const stored = readStored()
  if (stored?.account === account) {
    try {
      const bytes = await decryptWithAssociatedData(
        await sealingKey(keyHash),
        { iv: Uint8Array.fromBase64(stored.iv), ct: Uint8Array.fromBase64(stored.ct) },
        associatedData(account),
      )
      const token = new TextDecoder().decode(bytes)
      if (token.length === DEVICE_TOKEN_LENGTH) {
        return { token, stored: true }
      }
    } catch {
      // Sealed under another password
    }
  }
  return { token: generateDeviceToken(), stored: false }
}

/** Stores a device token the server has accepted, sealed for the password it came with */
export async function rememberDeviceToken(account: string, keyHash: string, token: string): Promise<void> {
  if (typeof localStorage === 'undefined') return
  const sealed = await encryptWithAssociatedData(
    await sealingKey(keyHash),
    new TextEncoder().encode(token),
    associatedData(account),
  )
  const record: StoredDeviceToken = { account, iv: sealed.iv.toBase64(), ct: sealed.ct.toBase64() }
  localStorage.setItem(getVaultStorageNames().loginDeviceKey, JSON.stringify(record))
}

export function clearDeviceToken(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(getVaultStorageNames().loginDeviceKey)
}
