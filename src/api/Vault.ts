import {
  vaultAddPushSubscription,
  vaultGetSession,
  vaultRecordPrayerCompletion,
  vaultUpdateReminderSettings,
  vaultDeletePushSubscription,
} from './VaultAPI'
import { useUiStore } from '../state/uiStore'
import { initAxios, setSessionExpiredHandler } from './axios'
import { getAccountId } from './util'
import {
  fromBytes,
  toBytes,
} from './crypto-utils'
import { queryClient } from './queryClient'
import type { WebPushSubscription } from '../vault/types'
import { clearPersistedAuthSyncState, useAuthStore } from '../state/authStore'
import { clearActiveSessionToken, clearOfflineQueue, setActiveSessionToken } from './offlineQueueStore'

export const VAULT_KEY_STORAGE_KEY = 'FlockVaultKey'
export const ACCOUNT_STORAGE_KEY = 'FlockVaultAccount'


export interface CryptoResult {
  iv: string,
  cipher: string,
  version?: number,
}

export interface VaultImportExportData {
  key: string,
}

let key: CryptoKey | null = null
let keyHash: string = ''
let session: string = ''

export function handleVaultError(error: Error, message: string) {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return
  }
  console.error(error)
  useUiStore.getState().setUi({
    message: {
      message,
      severity: 'error',
    },
  })
}

function getKey() {
  if (!key) {
    throw Error('Vault must be initialised before use')
  }
  return key
}

export function getVaultKey() {
  return getKey()
}

export function getVaultSession() {
  return session
}

async function updateKeyHash() {
  const keyBuffer = await crypto.subtle.exportKey('raw', getKey())
  const keyHashBytes = await crypto.subtle.digest('SHA-512', keyBuffer)
  keyHash = fromBytes(keyHashBytes)
  return keyHash
}

export async function loginVault({
  password,
  salt,
}: {
  password: string,
  salt: string,
}) {
  await initialiseVault({ password, salt })
  session = await vaultGetSession(keyHash)
  initAxios(session)
  await setActiveSessionToken(session)
  await storeVault()
}

export async function initialiseVault({
  password,
  iterations,
  salt,
}: {
  password: string,
  isNewAccount?: boolean,
  iterations?: number,
  salt: string,
}) {
  const enc = new TextEncoder()
  const keyBase = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey'],
  )
  key = await crypto.subtle.deriveKey(
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
  return updateKeyHash()
}

let isHandlingSessionExpiry = false

async function handleSessionExpired() {
  // Prevent multiple simultaneous session expiry handlers
  if (isHandlingSessionExpiry) return
  isHandlingSessionExpiry = true

  await signOutVault()
  useUiStore.getState().setUi({
    message: {
      message: 'Your session has expired. Please log in again.',
      severity: 'warning',
    },
  })

  // Reset flag after a short delay to allow re-triggering if needed
  setTimeout(() => {
    isHandlingSessionExpiry = false
  }, 1000)
}

export async function loadVault() {
  const { setAccount } = useAuthStore.getState()
  const account = localStorage.getItem(ACCOUNT_STORAGE_KEY)
  if (account) {
    setAccount({ account })
  }

  const storedKey = localStorage.getItem(VAULT_KEY_STORAGE_KEY)
  if (account && storedKey) {
    key = await crypto.subtle.importKey(
      'raw',
      toBytes(storedKey),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )

    await updateKeyHash()
    session = await vaultGetSession(keyHash)
    initAxios(session)
    await setActiveSessionToken(session)
    setSessionExpiredHandler(handleSessionExpired)

    setAccount({ loggedIn: true })
  }

  setAccount({ initializing: false })
}

export async function storeVault() {
  localStorage.setItem(
    VAULT_KEY_STORAGE_KEY,
    fromBytes(await crypto.subtle.exportKey('raw', getKey())),
  )
  localStorage.setItem(ACCOUNT_STORAGE_KEY, getAccountId())
}

export async function signOutVault() {
  const { setAccount } = useAuthStore.getState()
  key = null
  keyHash = ''
  session = ''
  initAxios('')

  // Stop current queries and clear cache
  queryClient.cancelQueries()
  queryClient.clear()

  // Clear state
  setAccount({ account: '', loggedIn: false })

  const localStorageKeys = Object.keys(localStorage)
  for (const localStorageKey of localStorageKeys) {
    if (localStorageKey.startsWith('lastSyncServerTime_')) {
      localStorage.removeItem(localStorageKey)
    }
  }

  localStorage.removeItem(VAULT_KEY_STORAGE_KEY)
  localStorage.removeItem(ACCOUNT_STORAGE_KEY)
  await clearActiveSessionToken()
  await clearOfflineQueue()
  await clearPersistedAuthSyncState()
}

export async function encrypt(plaintext: string): Promise<CryptoResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    getKey(),
    enc.encode(plaintext),
  )
  return {
    iv: fromBytes(iv.buffer),
    cipher: fromBytes(cipher),
  }
}

export async function decrypt(
  {
    iv,
    cipher,
  }: CryptoResult,
): Promise<string> {
  const key = getKey()
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBytes(iv) },
    key,
    toBytes(cipher),
  )
  const dec = new TextDecoder()
  return dec.decode(plaintext)
}

export function encryptObject(obj: object) {
  return encrypt(JSON.stringify(obj))
}

export async function decryptObject({ iv, cipher }: CryptoResult): Promise<object> {
  return JSON.parse(await decrypt({ iv, cipher }))
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(item => stripUndefinedDeep(item))
      .filter(item => item !== undefined)
  }

  if (value && typeof value === 'object') {
    // Preserve non-plain objects as-is.
    if (
      value instanceof Date
      || value instanceof Uint8Array
      || value instanceof ArrayBuffer
    ) {
      return value
    }

    const cleanedEntries = Object.entries(value as Record<string, unknown>)
      .flatMap(([key, nestedValue]) => {
        if (nestedValue === undefined) {
          return []
        }

        return [[key, stripUndefinedDeep(nestedValue)] as const]
      })

    return Object.fromEntries(cleanedEntries)
  }

  return value
}

/**
 * Automerge-based serialization for CRDT conflict resolution
 * Returns encrypted Automerge binary document
 */
export async function encryptObjectAsAutomerge(obj: object): Promise<{ encryptedAutomergeDoc: string; versionId: string }> {
  const Automerge = await import('@automerge/automerge')

  // Automerge rejects undefined field values; strip them recursively first.
  const cleanedObject = stripUndefinedDeep(obj) as Record<string, unknown>

  // Create new Automerge document from object
  const doc = Automerge.from(cleanedObject)

  // Serialize to binary
  const binary = Automerge.save(doc)

  // Encrypt the binary
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    getKey(),
    binary as BufferSource,
  )

  // Combine IV + ciphertext as hex string
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
  const ctHex = Array.from(new Uint8Array(cipher)).map(b => b.toString(16).padStart(2, '0')).join('')
  const encryptedAutomergeDoc = ivHex + ctHex

  // Generate versionId
  const versionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

  return { encryptedAutomergeDoc, versionId }
}

export function exportData<T>(payload: T): Promise<CryptoResult> {
  const data = JSON.stringify(payload)
  return encrypt(data)
}

export async function importData<T = unknown>(data: CryptoResult): Promise<T> {
  const plainData = await decrypt(data)
  return JSON.parse(plainData) as T
}

export async function addPushSubscription(subscription: WebPushSubscription): Promise<void> {
  await vaultAddPushSubscription(subscription)
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await vaultDeletePushSubscription(endpoint)
}

export async function updateReminderSettings(
  settings: { reminderEnabled: boolean, reminderTime: string, reminderTimezone: string },
): Promise<void> {
  await vaultUpdateReminderSettings(settings)
}

export async function recordPrayerCompletion(completedAt = Date.now()): Promise<void> {
  await vaultRecordPrayerCompletion(completedAt)
}
