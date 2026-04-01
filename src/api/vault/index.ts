import type { WebPushSubscription } from '../../vault/types'
import { clearPersistedAuthSyncState, useAuthStore } from '../../state/authStore'
import { queryClient } from '../queryClient'
import {
  clearActiveSessionToken,
  clearOfflineQueue,
  setActiveSessionToken,
} from '../../sync/offlineQueueStore'
import { getAccountId } from '../util'
import { setApiAuthToken, setApiSessionExpiredHandler } from '../runtime'
import {
  addPushSubscription as addPushSubscriptionClient,
  createAccount,
  deletePushSubscription as deletePushSubscriptionClient,
  getReminderSettings,
  getSalt,
  getSession,
  recordPrayerCompletion as recordPrayerCompletionClient,
  updateReminderSettings as updateReminderSettingsClient,
} from './client'
import {
  decryptWithKey,
  deriveVaultKey,
  encryptObjectAsAutomergeWithKey,
  encryptWithKey,
  exportVaultKey,
  hashVaultKey,
  importVaultKey,
  type CryptoResult,
} from './crypto'

export { createAccount, getSalt, getReminderSettings }
export type { CryptoResult }

export interface VaultImportExportData {
  key: string,
}

export const VAULT_STORAGE_KEY = 'FlockVaultMeta'

type VaultStoredMetadata = {
  account: string,
  key: string,
}

export class VaultNotInitializedError extends Error {
  constructor() {
    super('Vault must be initialised before use')
    this.name = 'VaultNotInitializedError'
  }
}

let key: CryptoKey | null = null
let keyHash = ''
let session = ''
let isHandlingSessionExpiry = false

function getKey() {
  if (!key) {
    throw new VaultNotInitializedError()
  }

  return key
}

export function getVaultKey() {
  return getKey()
}

export function getVaultSession() {
  return session
}

function readStoredMetadata(): VaultStoredMetadata | null {
  const serialized = localStorage.getItem(VAULT_STORAGE_KEY)
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as Partial<VaultStoredMetadata>
      if (typeof parsed.account === 'string' && typeof parsed.key === 'string') {
        return { account: parsed.account, key: parsed.key }
      }
    } catch {
      localStorage.removeItem(VAULT_STORAGE_KEY)
    }
  }

  return null
}

async function writeStoredMetadata() {
  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify({
    account: getAccountId(),
    key: await exportVaultKey(getKey()),
  } satisfies VaultStoredMetadata))
}

function clearStoredMetadata() {
  localStorage.removeItem(VAULT_STORAGE_KEY)
}

async function establishSessionFromKeyHash(nextKeyHash: string) {
  keyHash = nextKeyHash
  session = await getSession(nextKeyHash)
  setApiAuthToken(session)
  await setActiveSessionToken(session)
}

async function handleSessionExpired() {
  if (isHandlingSessionExpiry) {
    return
  }

  isHandlingSessionExpiry = true
  try {
    await signOutVault()
  } finally {
    setTimeout(() => {
      isHandlingSessionExpiry = false
    }, 1000)
  }
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
  key = await deriveVaultKey({ password, salt, iterations })
  keyHash = await hashVaultKey(getKey())
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
  await establishSessionFromKeyHash(keyHash)
  await storeVault()
}

export async function loadVault() {
  const { setAccount } = useAuthStore.getState()
  const stored = readStoredMetadata()

  if (stored?.account) {
    setAccount({ account: stored.account })
  }

  if (stored?.key) {
    key = await importVaultKey(stored.key)
    const nextKeyHash = await hashVaultKey(getKey())
    await establishSessionFromKeyHash(nextKeyHash)
    setApiSessionExpiredHandler(handleSessionExpired)
    setAccount({ loggedIn: true })
  }

  setAccount({ initializing: false })
}

export async function storeVault() {
  await writeStoredMetadata()
}

export async function signOutVault() {
  const { setAccount } = useAuthStore.getState()
  key = null
  keyHash = ''
  session = ''
  setApiAuthToken('')

  queryClient.cancelQueries()
  queryClient.clear()

  setAccount({ account: '', loggedIn: false })

  const localStorageKeys = Object.keys(localStorage)
  for (const localStorageKey of localStorageKeys) {
    if (localStorageKey.startsWith('lastSyncServerTime_')) {
      localStorage.removeItem(localStorageKey)
    }
  }

  clearStoredMetadata()
  await clearActiveSessionToken()
  await clearOfflineQueue()
  await clearPersistedAuthSyncState()
}

export async function encrypt(plaintext: string): Promise<CryptoResult> {
  return encryptWithKey(getKey(), plaintext)
}

export async function decrypt(data: CryptoResult): Promise<string> {
  return decryptWithKey(getKey(), data)
}

export async function decryptObject({ iv, cipher }: CryptoResult): Promise<object> {
  return JSON.parse(await decrypt({ iv, cipher }))
}

export async function encryptObjectAsAutomerge(obj: object): Promise<{ encryptedAutomergeDoc: string; versionId: string }> {
  return encryptObjectAsAutomergeWithKey(getKey(), obj)
}

export function exportData<T>(payload: T): Promise<CryptoResult> {
  return encrypt(JSON.stringify(payload))
}

export async function importData<T = unknown>(data: CryptoResult): Promise<T> {
  const plainData = await decrypt(data)
  return JSON.parse(plainData) as T
}

export async function addPushSubscription(subscription: WebPushSubscription): Promise<void> {
  await addPushSubscriptionClient(subscription)
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await deletePushSubscriptionClient(endpoint)
}

export async function updateReminderSettings(
  settings: { reminderEnabled: boolean, reminderTime: string, reminderTimezone: string },
): Promise<void> {
  await updateReminderSettingsClient(settings)
}

export async function recordPrayerCompletion(completedAt = Date.now()): Promise<void> {
  await recordPrayerCompletionClient(completedAt)
}
