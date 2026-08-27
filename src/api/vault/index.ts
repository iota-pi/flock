import {
  clearActiveSessionToken,
  getActiveSessionToken,
  setActiveSessionToken,
} from '../../sync/shared/workerAuthStore'
import { clearManualRecoveryEntries } from '../../sync/shared/manualRecoveryStore'
import { setApiAuthToken, setApiSessionExpiredHandler } from '../runtime'
import {
  createAccount,
  getSecurityParams,
  getSession,
  recordPrayerCompletion as recordPrayerCompletionClient,
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
import {
  clearBiometricData,
  readBiometricData,
  writeBiometricData,
  hasBiometricData,
  subscribeBiometrics,
} from './biometricStore'
import {
  registerPrfCredential,
  getPrfOutput,
  isWebAuthnPrfSupported,
} from './webauthn'
import { unsubscribe as unsubscribeFromNotifications } from 'src/utils/pushNotifications'

export {
  createAccount,
  getSecurityParams,
  clearBiometricData,
  readBiometricData,
  hasBiometricData,
  subscribeBiometrics,
  isWebAuthnPrfSupported,
  readStoredMetadata,
}
export type { CryptoResult }

export const KEYRING_CACHE_KEY = 'FlockKeyringCache'

export function readCachedKeyring(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(KEYRING_CACHE_KEY)
}

export function writeCachedKeyring(encryptedKeyring: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(KEYRING_CACHE_KEY, encryptedKeyring)
}

export function clearCachedKeyring(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(KEYRING_CACHE_KEY)
}

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
let activeAccount = ''
let sessionExpiryPromise: Promise<void> | null = null

export function getKeyHash(): string {
  return keyHash
}

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

async function writeStoredMetadata(
  account: string,
  params?: { salt?: string; iterations?: number; saltVersion?: number }
) {
  const existing = readStoredMetadata()
  localStorage.setItem(
    VAULT_STORAGE_KEY,
    JSON.stringify({
      account,
      salt: params?.salt ?? existing?.salt,
      iterations: params?.iterations ?? existing?.iterations,
      saltVersion: params?.saltVersion ?? existing?.saltVersion,
    } satisfies VaultStoredMetadata),
  )
}

function clearStoredMetadata() {
  localStorage.removeItem(VAULT_STORAGE_KEY)
}

export async function establishSessionFromKeyHash(account: string, nextKeyHash: string) {
  activeAccount = account
  keyHash = nextKeyHash
  session = await getSession(account, nextKeyHash)
  setApiAuthToken(session)
  await setActiveSessionToken(session)
  setApiSessionExpiredHandler(handleSessionExpired)
}

export function handleSessionExpired(): Promise<void> {
  if (sessionExpiryPromise) {
    return sessionExpiryPromise
  }

  sessionExpiryPromise = (async () => {
    try {
      const { useAppStore } = await import('src/state/store')
      const account = activeAccount || readStoredMetadata()?.account || useAppStore.getState().account

      if (account && keyHash) {
        try {
          await establishSessionFromKeyHash(account, keyHash)
          console.info('[vault] Session silently re-established')
          return
        } catch (err) {
          console.warn('[vault] Silent session re-establishment failed:', err)
        }
      }

      session = ''
      setApiAuthToken('')
      await clearActiveSessionToken()
      useAppStore.getState().setSyncStatus('offline')
      useAppStore.getState().setSyncWarning(
        'Sync paused: unable to re-establish session. Please re-enter your password to resume syncing.'
      )
    } finally {
      sessionExpiryPromise = null
    }
  })()

  return sessionExpiryPromise
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

export async function loadKeyringFromEncrypted(encryptedKeyringStr: string): Promise<void> {
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
}

export async function syncKeyringFromServer(account: string): Promise<void> {
  let encryptedKeyringStr: string | undefined
  try {
    encryptedKeyringStr = await getKeyring(account)
  } catch (err) {
    console.warn('[vault] Failed to retrieve keyring from server (network error):', err)
    return
  }

  if (encryptedKeyringStr) {
    try {
      await loadKeyringFromEncrypted(encryptedKeyringStr)
      writeCachedKeyring(encryptedKeyringStr)
    } catch (err) {
      clearKeyData()
      console.error('[vault] Failed to decrypt keyring from server during login:', err)
      throw new Error(
        `Failed to decrypt keyring from server during login: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  } else {
    try {
      await storeVault(account)
    } catch (err) {
      console.warn('[vault] Failed to seed keyring to server (network error):', err)
    }
  }
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
  account,
  password,
  salt,
  iterations,
  saltVersion,
}: {
  account: string,
  password: string,
  salt: string,
  iterations?: number,
  saltVersion?: number,
}) {
  await initialiseVault({ password, salt, iterations, saltVersion })

  let passwordVerified = false

  // Phase 1: Load cached keyring for offline operation
  const cachedKeyring = readCachedKeyring()
  if (cachedKeyring) {
    try {
      await loadKeyringFromEncrypted(cachedKeyring)
      passwordVerified = true
    } catch {
      clearCachedKeyring()
    }
  }

  // Phase 2: Best-effort server session
  try {
    await establishSessionFromKeyHash(account, keyHash)
    passwordVerified = true
  } catch (err) {
    console.info('[vault] Operating in offline mode — sync deferred:', err)
  }

  if (!passwordVerified) {
    clearKeyData()
    throw new Error('Incorrect password. Please try again.')
  }

  // If session was established, sync latest keyring from server
  if (session) {
    await syncKeyringFromServer(account)
  }

  await writeStoredMetadata(account, { salt, iterations, saltVersion })
}

export async function loadAccount() {
  const { useAppStore } = await import('src/state/store')
  const { updateAuth } = useAppStore.getState()
  const stored = readStoredMetadata()
  if (stored?.account) {
    updateAuth({ account: stored.account, initializing: false })
  } else {
    updateAuth({ initializing: false })
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

export async function storeVault(account: string) {
  const meta = readStoredMetadata()
  await writeStoredMetadata(account, {
    salt: meta?.salt,
    iterations: meta?.iterations,
    saltVersion: meta?.saltVersion,
  })
  const keyringData: Record<string, string> = {
    activeVersion: activeKeyVersion,
  }
  for (const [ver, k] of keyring.entries()) {
    keyringData[ver] = await exportVaultKey(k)
  }
  const plaintext = JSON.stringify(keyringData)
  const encryptionKey = masterKey || getVaultKey('1')
  const encrypted = await encryptWithKey(encryptionKey, plaintext, 'master')
  const encryptedStr = JSON.stringify(encrypted)
  writeCachedKeyring(encryptedStr)

  if (session) {
    await updateKeyring(account, encryptedStr)
  }
}

function clearKeyData() {
  keyring.clear()
  masterKey = null
  activeKeyVersion = '1'
  keyHash = ''
  session = ''
  activeAccount = ''
  setApiAuthToken('')
}

export async function lockVault() {
  const { useAppStore } = await import('src/state/store')
  const { updateAuth } = useAppStore.getState()
  clearKeyData()
  await clearActiveSessionToken()

  await SyncBridge.shutdown({ clearLocalData: false })

  updateAuth({ loggedIn: false })
}

export async function removeVaultFromDevice() {
  const { useAppStore } = await import('src/state/store')
  const { account, updateAuth } = useAppStore.getState()

  await SyncBridge.shutdown({ clearLocalData: true })

  if (account) {
    try {
      await unsubscribeFromNotifications(account)
    } catch (error) {
      console.error('Failed to unsubscribe from notifications', error)
    }
    await clearSyncBatch(account)
    await clearScheduledDeletions(account)
    await clearManualRecoveryEntries(account)
  }
  clearKeyData()
  clearBiometricData()
  clearCachedKeyring()
  await clearActiveSessionToken()
  clearStoredMetadata()
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

export async function recordPrayerCompletion(account: string, completedAt = Date.now()): Promise<void> {
  await recordPrayerCompletionClient(account, completedAt)
}

export async function changePassword(account: string, currentPassword: string, newPassword: string): Promise<void> {
  const {
    salt: currentSalt,
    iterations: currentIterations,
    saltVersion: currentSaltVersion,
  } = await getSecurityParams(account)
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
    account,
    currentAuthToken,
    newAuthToken,
    newSalt,
    newIterations,
    newKeyring: JSON.stringify(encryptedKeyring),
    saltVersion: newSaltVersion,
  })

  masterKey = newMasterKey
  clearBiometricData()
  writeCachedKeyring(JSON.stringify(encryptedKeyring))
  await writeStoredMetadata(account, {
    salt: newSalt,
    iterations: newIterations,
    saltVersion: newSaltVersion,
  })
  await establishSessionFromKeyHash(account, newAuthToken)
}

export async function rotateVaultKey(account: string): Promise<void> {
  const newKey = await generateVaultKey()
  const currentActiveVer = parseInt(activeKeyVersion, 10)
  const nextActiveVer = (currentActiveVer + 1).toString()
  keyring.set(nextActiveVer, newKey)
  activeKeyVersion = nextActiveVer
  try {
    await storeVault(account)
  } catch (err) {
    keyring.delete(nextActiveVer)
    activeKeyVersion = currentActiveVer.toString()
    throw new Error(
      `Key rotation failed: keyring upload unsuccessful. Local state rolled back. Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

export async function enableBiometrics(account: string): Promise<void> {
  const currentKey = masterKey || getVaultKey('1')

  const { credentialId, prfSalt, prfOutput } = await registerPrfCredential(account)

  const prfKey = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  const exportedMasterKey = await exportVaultKey(currentKey)
  const encrypted = await encryptWithKey(prfKey, exportedMasterKey, 'master')

  writeBiometricData({
    account,
    credentialId,
    prfSalt,
    encryptedMasterKey: {
      iv: encrypted.iv,
      cipher: encrypted.cipher,
    },
  })
}

export function getBiometricLabel(): string {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'Biometrics'
  }
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/.test(ua)) {
    return 'Touch ID / Face ID'
  }
  if (/Macintosh|Mac OS X/.test(ua)) {
    return 'Touch ID'
  }
  if (/Windows/.test(ua)) {
    return 'Windows Hello'
  }
  if (/Android/.test(ua)) {
    return 'Fingerprint / Face Unlock'
  }
  return 'Biometrics'
}

export function disableBiometrics(): void {
  clearBiometricData()
}

export async function unlockWithBiometrics(account: string): Promise<void> {
  const data = readBiometricData()
  if (!data) {
    throw new Error('No biometric credential saved on this device')
  }

  const prfOutput = await getPrfOutput(data.credentialId, data.prfSalt)

  const prfKey = await crypto.subtle.importKey(
    'raw',
    prfOutput,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )

  const exportedMasterKey = await decryptWithKey(prfKey, {
    iv: data.encryptedMasterKey.iv,
    cipher: data.encryptedMasterKey.cipher,
  })

  const derivedKey = await importVaultKey(exportedMasterKey)
  masterKey = derivedKey
  keyring.clear()
  keyring.set('1', derivedKey)
  activeKeyVersion = '1'
  keyHash = await hashVaultKey(derivedKey)

  // Phase 1: Load cached keyring for offline access
  const cachedKeyring = readCachedKeyring()
  if (cachedKeyring) {
    try {
      await loadKeyringFromEncrypted(cachedKeyring)
    } catch {
      clearCachedKeyring()
    }
  }

  // Phase 2: Best-effort server session + keyring sync
  try {
    await establishSessionFromKeyHash(account, keyHash)
    await syncKeyringFromServer(account)
  } catch (err) {
    console.info('[vault] Biometric unlock in offline mode:', err)
  }

  const meta = readStoredMetadata()
  await writeStoredMetadata(account, {
    salt: meta?.salt,
    iterations: meta?.iterations,
    saltVersion: meta?.saltVersion,
  })
}

