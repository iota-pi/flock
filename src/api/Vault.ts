import {
  vaultDeleteSubscription,
  vaultGetSession,
  vaultGetSubscription,
  vaultSetSubscription,
} from './VaultAPI'
import {
  Item,
} from '../state/items'
import { setAccount } from '../state/account'
import store, { AppDispatch } from '../store'
import { FlockPushSubscription } from '../utils/firebase-types'
import { initAxios, setSessionExpiredHandler } from './axios'
import { getAccountId } from './util'
import { setUi } from '../state/ui'
import {
  fromBytes,
  fromBytesUrlSafe,
  toBytes,
} from './crypto-utils'
import { queryClient } from './client'

export const VAULT_KEY_STORAGE_KEY = 'FlockVaultKey'
export const ACCOUNT_STORAGE_KEY = 'FlockVaultAccount'


export interface CryptoResult {
  iv: string,
  cipher: string,
}

export interface VaultImportExportData {
  key: string,
}

export interface VaultConstructorData {
  account: string,
  dispatch: AppDispatch,
  key: CryptoKey,
  keyHash: string,
}

let key: CryptoKey | null = null
let keyHash: string = ''
let session: string = ''

export function handleVaultError(error: Error, message: string) {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return
  }
  console.error(error)
  store.dispatch(setUi({
    message: {
      message,
      severity: 'error',
    },
  }))
}

function getKey() {
  if (!key) {
    throw Error('Vault must be initialised before use')
  }
  return key
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

function handleSessionExpired() {
  // Prevent multiple simultaneous session expiry handlers
  if (isHandlingSessionExpiry) return
  isHandlingSessionExpiry = true

  signOutVault()
  store.dispatch(setUi({
    message: {
      message: 'Your session has expired. Please log in again.',
      severity: 'warning',
    },
  }))

  // Reset flag after a short delay to allow re-triggering if needed
  setTimeout(() => {
    isHandlingSessionExpiry = false
  }, 1000)
}

export async function loadVault() {
  const account = localStorage.getItem(ACCOUNT_STORAGE_KEY)
  if (account) {
    store.dispatch(setAccount({ account }))
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
    setSessionExpiredHandler(handleSessionExpired)

    store.dispatch(setAccount({ loggedIn: true }))
  }

  store.dispatch(setAccount({ initializing: false }))
}

export async function storeVault() {
  localStorage.setItem(
    VAULT_KEY_STORAGE_KEY,
    fromBytes(await crypto.subtle.exportKey('raw', getKey())),
  )
  localStorage.setItem(ACCOUNT_STORAGE_KEY, getAccountId())
}

export function signOutVault() {
  key = null
  keyHash = ''
  initAxios('')

  // Stop current queries and clear cache
  queryClient.cancelQueries()
  queryClient.clear()

  // Clear state
  store.dispatch(setAccount({ account: '', loggedIn: false }))
  localStorage.removeItem(VAULT_KEY_STORAGE_KEY)
  localStorage.removeItem(ACCOUNT_STORAGE_KEY)
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

export function exportData(items: Item[]): Promise<CryptoResult> {
  const data = JSON.stringify(items)
  return encrypt(data)
}

export async function importData(data: CryptoResult): Promise<Item[]> {
  const plainData = await decrypt(data)
  return JSON.parse(plainData)
}

async function getSubscriptionId(subscriptionToken: string): Promise<string> {
  const enc = new TextEncoder()
  const buffer = await crypto.subtle.digest('SHA-512', enc.encode(subscriptionToken))
  return fromBytesUrlSafe(buffer)
}

export async function getSubscription(subscriptionToken: string): Promise<FlockPushSubscription | null> {
  const result = await vaultGetSubscription({
    subscriptionId: await getSubscriptionId(subscriptionToken),
  })
  return result
}

export async function setSubscription(subscription: FlockPushSubscription): Promise<void> {
  await vaultSetSubscription({
    subscriptionId: await getSubscriptionId(subscription.token),
    subscription,
  })
}

export async function deleteSubscription(subscriptionToken: string): Promise<void> {
  await vaultDeleteSubscription({
    subscriptionId: await getSubscriptionId(subscriptionToken),
  })
}
