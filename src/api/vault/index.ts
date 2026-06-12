import type { WebPushSubscription } from '../../vault/types'
import { useAppStore } from '../../state/store'
import {
  clearActiveSessionToken,
  getActiveSessionToken,
  setActiveSessionToken,
} from '../../sync/shared/workerAuthStore'
import { clearManualRecoveryEntries } from '../../sync/shared/manualRecoveryStore'
import { getAccountId } from '../util'
import { setApiAuthToken, setApiSessionExpiredHandler } from '../runtime'
import {
  addPushSubscription as addPushSubscriptionClient,
  createAccount,
  deletePushSubscription as deletePushSubscriptionClient,
  getReminderSettings,
  getSecurityParams,
  getSession,
  recordPrayerCompletion as recordPrayerCompletionClient,
  updateReminderSettings as updateReminderSettingsClient,
  getKeyring,
  updateKeyring,
  changePassword as changePasswordClient,
} from './client'
import {
  decryptWithKey,
  deriveVaultKey,
  encryptWithKey,
  exportVaultKey,
  hashVaultKey,
  importVaultKey,
  encryptBytesWithKey,
  decryptBytesWithKey,
  generateSalt,
  generateVaultKey,
  type CryptoResult,
} from './crypto'
import { SyncBridge } from 'src/sync/client/SyncBridge'
import { readStoredMetadata, VAULT_STORAGE_KEY, VaultStoredMetadata, DEFAULT_CRYPTO_ITERATIONS } from './util'
import { clearSyncBatch } from 'src/sync/shared/VaultPersistence'
import { clearScheduledDeletions } from 'src/sync/shared/deletionQueueStore'

export { createAccount, getSecurityParams, getReminderSettings }
export type { CryptoResult }

export interface VaultImportExportData {
  key: string,
}

export class VaultNotInitializedError extends Error {
  constructor() {
    super('Vault must be initialised before use')
    this.name = 'VaultNotInitializedError'
  }
}

const keyring: Map<string, CryptoKey> = new Map()
let masterKey: CryptoKey | null = null
let activeKeyVersion = '1'
let keyHash = ''
let session = ''
let isHandlingSessionExpiry = false

function getActiveKey(): CryptoKey {
  const k = keyring.get(activeKeyVersion)
  if (!k) {
    throw new VaultNotInitializedError()
  }
  return k
}


export function getVaultKey(kver?: string): CryptoKey {
  if (!kver) {
    return getActiveKey()
  }
  const k = keyring.get(kver)
  if (!k) {
    throw new Error(`Vault key version ${kver} not found in keyring`)
  }
  return k
}

export function getVaultSession() {
  return session
}

async function writeStoredMetadata() {
  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify({
    account: getAccountId(),
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
  setApiSessionExpiredHandler(handleSessionExpired)
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
  saltVersion,
}: {
  password: string,
  isNewAccount?: boolean,
  iterations?: number,
  salt: string,
  saltVersion?: number,
}) {
  const derivedKey = await deriveVaultKey({ password, salt, iterations, saltVersion })
  masterKey = derivedKey
  keyring.clear()
  keyring.set('1', derivedKey)
  activeKeyVersion = '1'
  keyHash = await hashVaultKey(derivedKey)
  return keyHash
}

export async function initWorkerVault(vaultKeyOrKeyring: string) {
  keyring.clear()
  try {
    const keyringData = JSON.parse(vaultKeyOrKeyring)
    if (keyringData && typeof keyringData === 'object' && keyringData.activeVersion) {
      activeKeyVersion = keyringData.activeVersion as string
      for (const [ver, expKey] of Object.entries(keyringData)) {
        if (ver !== 'activeVersion') {
          keyring.set(ver, await importVaultKey(expKey as string))
        }
      }
    } else {
      throw new Error('Not a structured keyring')
    }
  } catch (_) {
    // Legacy single key
    const imported = await importVaultKey(vaultKeyOrKeyring)
    keyring.set('1', imported)
    activeKeyVersion = '1'
  }

  const sessionToken = await getActiveSessionToken()
  if (sessionToken) {
    setApiAuthToken(sessionToken)
  } else {
    console.warn('[SyncWorker] Missing session token for realtime sync; network pushes will not start.')
  }
}

export async function loginVault({
  password,
  salt,
  iterations,
  saltVersion,
}: {
  password: string,
  salt: string,
  iterations?: number,
  saltVersion?: number,
}) {
  await initialiseVault({ password, salt, iterations, saltVersion })
  await establishSessionFromKeyHash(keyHash)

  let keyringNeedsUpload = false
  try {
    const encryptedKeyringStr = await getKeyring()
    if (encryptedKeyringStr) {
      const encryptedKeyring = JSON.parse(encryptedKeyringStr) as CryptoResult
      const decryptionKey = masterKey || getVaultKey('1')
      const plaintext = await decryptWithKey(decryptionKey, encryptedKeyring)
      const keyringData = JSON.parse(plaintext)
      if (keyringData && typeof keyringData === 'object' && keyringData.activeVersion) {
        activeKeyVersion = keyringData.activeVersion as string
        for (const [ver, expKey] of Object.entries(keyringData)) {
          if (ver !== 'activeVersion') {
            keyring.set(ver, await importVaultKey(expKey as string))
          }
        }
      }
    } else {
      keyringNeedsUpload = true
    }
  } catch (err) {
    console.error('[vault] Failed to retrieve keyring from server during login:', err)
  }

  if (keyringNeedsUpload) {
    await storeVault()
  } else {
    await writeStoredMetadata()
  }
}

export async function loadAccount() {
  const { updateAuth } = useAppStore.getState()
  const stored = readStoredMetadata()
  if (stored?.account) {
    updateAuth({ account: stored.account })
  }
}

export async function exportKeyringData(): Promise<string> {
  const keyringData: Record<string, string> = {
    activeVersion: activeKeyVersion,
  }
  for (const [ver, k] of keyring.entries()) {
    keyringData[ver] = await exportVaultKey(k)
  }
  return JSON.stringify(keyringData)
}

export async function storeVault() {
  await writeStoredMetadata()
  if (session) {
    try {
      const keyringData: Record<string, string> = {
        activeVersion: activeKeyVersion,
      }
      for (const [ver, k] of keyring.entries()) {
        keyringData[ver] = await exportVaultKey(k)
      }
      const plaintext = JSON.stringify(keyringData)
      const encryptionKey = masterKey || getVaultKey('1')
      const encrypted = await encryptWithKey(encryptionKey, plaintext, 'master')
      await updateKeyring(JSON.stringify(encrypted))
    } catch (err) {
      console.error('[vault] Failed to sync keyring to server:', err)
    }
  }
}

export async function signOutVault() {
  const { updateAuth } = useAppStore.getState()
  keyring.clear()
  masterKey = null
  activeKeyVersion = '1'
  keyHash = ''
  session = ''
  setApiAuthToken('')

  await SyncBridge.shutdown()

  const accountId = getAccountId()
  await clearSyncBatch(accountId)
  await clearScheduledDeletions(accountId)
  clearStoredMetadata()
  await clearActiveSessionToken()
  await clearManualRecoveryEntries(accountId)

  updateAuth({ account: '', loggedIn: false })
}

export async function encrypt(plaintext: string): Promise<CryptoResult> {
  return encryptWithKey(getActiveKey(), plaintext, activeKeyVersion)
}

export async function decrypt(data: CryptoResult): Promise<string> {
  const kver = data.kver || '1'
  return decryptWithKey(getVaultKey(kver), data)
}

export async function decryptObject({ iv, cipher, kver }: CryptoResult): Promise<object> {
  return JSON.parse(await decrypt({ iv, cipher, kver }))
}

export function exportData<T>(payload: T): Promise<CryptoResult> {
  return encrypt(JSON.stringify(payload))
}

export async function importData<T = unknown>(data: CryptoResult): Promise<T> {
  const plainData = await decrypt(data)
  return JSON.parse(plainData) as T
}

export async function encryptBytes(bytes: Uint8Array): Promise<CryptoResult> {
  return encryptBytesWithKey(getActiveKey(), bytes, activeKeyVersion)
}

export async function decryptBytes(data: CryptoResult): Promise<Uint8Array> {
  const kver = data.kver || '1'
  return decryptBytesWithKey(getVaultKey(kver), data)
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

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const {
    salt: currentSalt,
    iterations: currentIterations,
    saltVersion: currentSaltVersion,
  } = await getSecurityParams()
  const currentMasterKey = await deriveVaultKey({
    password: currentPassword,
    salt: currentSalt,
    iterations: currentIterations,
    saltVersion: currentSaltVersion,
  })
  const currentAuthToken = await hashVaultKey(currentMasterKey)

  const newSalt = generateSalt()
  const newIterations = DEFAULT_CRYPTO_ITERATIONS
  const newSaltVersion = 1

  const newMasterKey = await deriveVaultKey({
    password: newPassword,
    salt: newSalt,
    iterations: newIterations,
    saltVersion: newSaltVersion,
  })
  const newAuthToken = await hashVaultKey(newMasterKey)

  const keyringData: Record<string, string> = {
    activeVersion: activeKeyVersion,
  }
  for (const [ver, k] of keyring.entries()) {
    keyringData[ver] = await exportVaultKey(k)
  }
  const plaintext = JSON.stringify(keyringData)
  const encryptedKeyring = await encryptWithKey(newMasterKey, plaintext, 'master')

  await changePasswordClient({
    currentAuthToken,
    newAuthToken,
    newSalt,
    newIterations,
    newKeyring: JSON.stringify(encryptedKeyring),
    saltVersion: newSaltVersion,
  })

  masterKey = newMasterKey
  keyHash = newAuthToken
  await writeStoredMetadata()
}

export async function rotateVaultKey(): Promise<void> {
  const newKey = await generateVaultKey()
  const currentActiveVer = parseInt(activeKeyVersion, 10)
  const nextActiveVer = (currentActiveVer + 1).toString()
  keyring.set(nextActiveVer, newKey)
  activeKeyVersion = nextActiveVer
  await storeVault()
}
