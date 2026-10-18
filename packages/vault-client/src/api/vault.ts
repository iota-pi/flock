import {
  clearActiveSessionToken,
  setActiveSessionToken,
} from '../sync/shared/workerAuthStore'
import { clearManualRecoveryEntries } from '../sync/shared/manualRecoveryStore'
import { setApiAuthToken, setApiSessionExpiredHandler } from './runtime'
import {
  createAccount,
  getSecurityParams,
  getSession,
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
  generateSalt,
  generateVaultKey,
  CURRENT_SALT_VERSION,
  type CryptoResult,
} from './crypto'
import {
  broadcastVaultEvent,
  readStoredMetadata,
  VaultStoredMetadata,
  DEFAULT_CRYPTO_ITERATIONS,
  type VaultBroadcastEvent,
} from './util'
import { SyncWriteAheadLog } from '../sync/worker/SyncWriteAheadLog'
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
import { getVaultStorageNames } from '../sync/shared/storageNames'
import { ApiHttpError } from './trackedFetch'
import { importKeyring, Keyring, VaultNotInitializedError, type KeyProvider } from './Keyring'

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
export type { VaultBroadcastEvent }

export function readCachedKeyring(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem(getVaultStorageNames().keyringCacheKey)
}

export function writeCachedKeyring(encryptedKeyring: string): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(getVaultStorageNames().keyringCacheKey, encryptedKeyring)
}

export function clearCachedKeyring(): void {
  if (typeof localStorage === 'undefined') return
  localStorage.removeItem(getVaultStorageNames().keyringCacheKey)
}

export interface VaultImportExportData {
  key: string,
}

export interface VaultHostHooks {
  /** Account to restore the session for when none has been established in this realm yet */
  getAccountId?: () => string | undefined
  /** Called when the session has expired and could not be silently re-established */
  onSessionLost?: (message: string) => void
  /**
   * Called when the server turned away a write because this build is too old, from any realm or
   * tab. The app should update itself (fetch the new service worker and reload).
   */
  onClientOutdated?: () => void
  /**
   * Decodes salts from before `saltVersion` 1, so accounts that still use them can log in (and be
   * upgraded). Without it, logging in to such an account fails.
   */
  decodeLegacySalt?: (salt: string) => ArrayBuffer
}

let hostHooks: VaultHostHooks = {}
let vaultEventsListener: BroadcastChannel | null = null

/** Connects the vault to the host app. Call once at startup on the main thread. */
export function configureVaultHost(hooks: VaultHostHooks): void {
  hostHooks = hooks

  vaultEventsListener?.close()
  vaultEventsListener = null
  if (hooks.onClientOutdated && typeof BroadcastChannel !== 'undefined') {
    vaultEventsListener = new BroadcastChannel(getVaultStorageNames().vaultEventsChannel)
    vaultEventsListener.onmessage = (event: MessageEvent<VaultBroadcastEvent>) => {
      if (event.data?.type === 'CLIENT_OUTDATED') {
        hostHooks.onClientOutdated?.()
      }
    }
  }
}

export class StaleBiometricKeyError extends Error {
  constructor() {
    super('The key saved for biometric unlock no longer matches the account')
    this.name = 'StaleBiometricKeyError'
  }
}

export { VaultNotInitializedError }
export type { KeyProvider }

/** This realm's keys. The sync worker keeps its own `Keyring`, loaded from `exportKeyringData`. */
const keyring = new Keyring()
let masterKey: CryptoKey | null = null
let keyHash = ''
let session = ''
let activeAccount = ''
let sessionExpiryPromise: Promise<void> | null = null
// Bumped whenever the keys are forgotten, so a request that finishes after locking can't restore a session
let keyGeneration = 0
const lateSessionListeners = new Set<() => void>()

/** How long a login waits for the server once the cached keyring has verified the password */
const LOGIN_SERVER_WAIT_MS = 3000

export function getKeyHash(): string {
  return keyHash
}

export function hasVaultKey(kver?: string): boolean {
  return keyring.hasKey(kver)
}

export async function reloadKeyringFromStorage(): Promise<{
  success: boolean
  passwordChanged?: boolean
  keyringData?: string
}> {
  const cachedKeyring = readCachedKeyring()
  if (!cachedKeyring) {
    return { success: false }
  }

  try {
    await loadKeyringFromEncrypted(cachedKeyring)
    const keyringData = await exportKeyringData()
    return { success: true, keyringData }
  } catch (err) {
    console.warn('[vault] Failed to decrypt cached keyring with current masterKey:', err)
    return { success: false, passwordChanged: true }
  }
}

/** The password-derived key that wraps the keyring, which is set whenever the keyring has keys */
function requireMasterKey(): CryptoKey {
  if (!masterKey) {
    throw new VaultNotInitializedError()
  }
  return masterKey
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
    getVaultStorageNames().vaultMetadataKey,
    JSON.stringify({
      account,
      salt: params?.salt ?? existing?.salt,
      iterations: params?.iterations ?? existing?.iterations,
      saltVersion: params?.saltVersion ?? existing?.saltVersion,
    } satisfies VaultStoredMetadata),
  )
}

function clearStoredMetadata() {
  localStorage.removeItem(getVaultStorageNames().vaultMetadataKey)
}

export async function establishSessionFromKeyHash(account: string, nextKeyHash: string) {
  const generation = keyGeneration
  const nextSession = await getSession(account, nextKeyHash)
  if (generation !== keyGeneration) {
    throw new Error('The vault was locked before the session was established')
  }
  activeAccount = account
  keyHash = nextKeyHash
  session = nextSession
  setApiAuthToken(session)
  await setActiveSessionToken(session)
  if (generation !== keyGeneration) {
    await clearActiveSessionToken()
    return
  }
  setApiSessionExpiredHandler(handleSessionExpired)
}

/**
 * Calls `listener` when a login that stopped waiting for the server (see `loginVault`) later gets a
 * session and the server's keyring. Returns a function that removes the listener.
 */
export function onLateSession(listener: () => void): () => void {
  lateSessionListeners.add(listener)
  return () => {
    lateSessionListeners.delete(listener)
  }
}

function notifyLateSession() {
  for (const listener of lateSessionListeners) {
    listener()
  }
}

/** Resolves (to undefined) once a login has waited long enough for the server */
function serverWaitElapsed(): Promise<undefined> {
  return new Promise(resolve => setTimeout(resolve, LOGIN_SERVER_WAIT_MS))
}

async function finishSessionInBackground(attempt: Promise<boolean>, account: string) {
  const generation = keyGeneration
  if (!await attempt || generation !== keyGeneration) return
  try {
    await syncKeyringFromServer(account)
  } catch (err) {
    console.warn('[vault] Failed to sync the keyring after a late session:', err)
    return
  }
  if (generation !== keyGeneration) return
  notifyLateSession()
}

export function handleSessionExpired(): Promise<void> {
  if (sessionExpiryPromise) {
    return sessionExpiryPromise
  }

  sessionExpiryPromise = (async () => {
    try {
      const account = activeAccount || readStoredMetadata()?.account || hostHooks.getAccountId?.()

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
      hostHooks.onSessionLost?.(
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
  const derivedKey = await deriveVaultKey({
    password,
    salt,
    iterations,
    saltVersion,
    decodeLegacySalt: hostHooks.decodeLegacySalt,
  })
  masterKey = derivedKey
  keyring.replace(new Map([['1', derivedKey]]), '1')
  keyHash = await hashVaultKey(derivedKey)
  return keyHash
}

export async function loadKeyringFromEncrypted(encryptedKeyringStr: string): Promise<void> {
  const encryptedKeyring = JSON.parse(encryptedKeyringStr) as CryptoResult
  const decryptionKey = requireMasterKey()
  const plaintext = await decryptWithKey(decryptionKey, encryptedKeyring)
  const keyringData = JSON.parse(plaintext)
  if (keyringData && typeof keyringData === 'object' && keyringData.activeVersion) {
    const { keys, activeVersion } = await importKeyring(keyringData)
    keyring.merge(keys, activeVersion)
  }
}

/** Loads the server's keyring. Returns whether it was loaded (rather than missing or unreachable). */
export async function syncKeyringFromServer(account: string): Promise<boolean> {
  let encryptedKeyringStr: string | undefined
  try {
    encryptedKeyringStr = await getKeyring(account)
  } catch (err) {
    console.warn('[vault] Failed to retrieve keyring from server (network error):', err)
    return false
  }

  if (encryptedKeyringStr) {
    try {
      await loadKeyringFromEncrypted(encryptedKeyringStr)
      writeCachedKeyring(encryptedKeyringStr)
      return true
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
    return false
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
}): Promise<{ keyDerivationUpgraded: boolean, biometricsCleared: boolean }> {
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

  // Phase 2: Best-effort server session. Once the cached keyring has verified the password, a slow
  // server doesn't hold up unlocking: the session is finished in the background instead.
  const sessionAttempt = establishSessionFromKeyHash(account, keyHash).then(
    () => true,
    (err: unknown) => {
      console.info('[vault] Operating in offline mode — sync deferred:', err)
      return false
    },
  )
  const sessionEstablished = passwordVerified
    ? await Promise.race([sessionAttempt, serverWaitElapsed()])
    : await sessionAttempt

  if (sessionEstablished) {
    passwordVerified = true
  }

  if (!passwordVerified) {
    clearKeyData()
    throw new Error('Incorrect password. Please try again.')
  }

  if (sessionEstablished === undefined) {
    console.info('[vault] The server is slow to respond; finishing the session in the background')
    void finishSessionInBackground(sessionAttempt, account)
  }

  // If session was established, sync latest keyring from server
  const serverKeyringLoaded = sessionEstablished ? await syncKeyringFromServer(account) : false

  await writeStoredMetadata(account, { salt, iterations, saltVersion })

  // Upgrade outdated key derivation by changing the password to itself. The re-wrapped keyring must
  // hold every key, so this waits until the server's keyring has been loaded.
  if (serverKeyringLoaded && needsKeyDerivationUpgrade({ saltVersion, iterations })) {
    const hadBiometrics = hasBiometricData()
    try {
      await rewrapMasterKey({ account, currentAuthToken: keyHash, newPassword: password })
      return { keyDerivationUpgraded: true, biometricsCleared: hadBiometrics }
    } catch (err) {
      console.warn('[vault] Failed to upgrade key derivation; will retry at the next login:', err)
    }
  }
  return { keyDerivationUpgraded: false, biometricsCleared: false }
}

/** Whether keys derived with these parameters should be re-derived with a new salt at the next login */
export function needsKeyDerivationUpgrade(
  { saltVersion, iterations }: { saltVersion?: number, iterations?: number },
): boolean {
  return saltVersion !== CURRENT_SALT_VERSION || (iterations ?? 0) < DEFAULT_CRYPTO_ITERATIONS
}

/** Exports the keyring as JSON, for the sync worker's `Keyring.load` */
export async function exportKeyringData(): Promise<string> {
  return JSON.stringify(await keyring.export())
}

export async function storeVault(account: string, activeVersionOverride?: string) {
  const effectiveVersion = activeVersionOverride ?? keyring.activeVersion
  const meta = readStoredMetadata()
  await writeStoredMetadata(account, {
    salt: meta?.salt,
    iterations: meta?.iterations,
    saltVersion: meta?.saltVersion,
  })
  const plaintext = JSON.stringify(await keyring.export(effectiveVersion))
  const encryptionKey = requireMasterKey()
  const encrypted = await encryptWithKey(encryptionKey, plaintext, 'master')
  const encryptedStr = JSON.stringify(encrypted)

  if (session) {
    const currentVer = parseInt(effectiveVersion, 10)
    const expectedVer = Math.max(currentVer - 1, 1)
    await updateKeyring(account, encryptedStr, expectedVer, currentVer)
  }

  writeCachedKeyring(encryptedStr)
}

function clearKeyData() {
  keyGeneration += 1
  keyring.clear()
  masterKey = null
  keyHash = ''
  session = ''
  activeAccount = ''
  setApiAuthToken('')
  setApiSessionExpiredHandler(null)
}

/**
 * Forgets the in-memory keys and the session token. The host app is responsible for stopping sync
 * and updating its own state.
 */
export async function lockVaultKeys() {
  clearKeyData()
  await clearActiveSessionToken()
}

/**
 * Removes every trace of the vault from this device: keys, the session, cached keyring, biometric
 * unlock data and stored metadata, plus the account's WAL and manual recovery entries. Shut the sync
 * worker down (clearing its local data) before calling this.
 */
export async function clearVaultDeviceData(account?: string) {
  if (account) {
    await SyncWriteAheadLog.clear(account)
    await clearManualRecoveryEntries(account)
  }
  clearKeyData()
  clearBiometricData()
  clearCachedKeyring()
  await clearActiveSessionToken()
  clearStoredMetadata()
}

export async function encrypt(plaintext: string): Promise<CryptoResult> {
  return keyring.encrypt(plaintext)
}

export async function decrypt(data: CryptoResult): Promise<string> {
  return keyring.decrypt(data)
}

export function exportData<T>(payload: T): Promise<CryptoResult> {
  return encrypt(JSON.stringify(payload))
}

export async function importData<T = unknown>(data: CryptoResult): Promise<T> {
  const plainData = await decrypt(data)
  return JSON.parse(plainData) as T
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
    decodeLegacySalt: hostHooks.decodeLegacySalt,
  })
  const currentAuthToken = await hashVaultKey(currentMasterKey)
  await rewrapMasterKey({ account, currentAuthToken, newPassword })
}

/**
 * Derives a new master key from `newPassword` with a fresh salt and the current parameters,
 * re-wraps the keyring with it and replaces the account's credentials. This signs out every other
 * session and clears biometric unlock on this device.
 */
async function rewrapMasterKey({
  account,
  currentAuthToken,
  newPassword,
}: {
  account: string,
  currentAuthToken: string,
  newPassword: string,
}): Promise<void> {
  const newSalt = generateSalt()
  const newIterations = DEFAULT_CRYPTO_ITERATIONS
  const newSaltVersion = CURRENT_SALT_VERSION

  const newMasterKey = await deriveVaultKey({
    password: newPassword,
    salt: newSalt,
    iterations: newIterations,
    saltVersion: newSaltVersion,
  })
  const newAuthToken = await hashVaultKey(newMasterKey)

  const plaintext = JSON.stringify(await keyring.export())
  const encryptedKeyring = await encryptWithKey(newMasterKey, plaintext, 'master')

  const currentKeyringVer = parseInt(keyring.activeVersion, 10)

  await changePasswordClient({
    account,
    currentAuthToken,
    newAuthToken,
    newSalt,
    newIterations,
    newKeyring: JSON.stringify(encryptedKeyring),
    saltVersion: newSaltVersion,
    expectedKeyringVersion: currentKeyringVer,
    keyringVersion: currentKeyringVer,
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
  broadcastVaultEvent({ type: 'PASSWORD_CHANGED', account })
}

/**
 * Adds a new data key and makes it active once the server holds it. Without a session, `storeVault`
 * would only cache the keyring locally, leaving data encrypted with a key no other device can get.
 */
export async function rotateVaultKey(account: string): Promise<void> {
  if (!session) {
    throw new Error('Key rotation needs a connection to the server. Please try again once you are online.')
  }
  const newKey = await generateVaultKey()
  const currentActiveVer = parseInt(keyring.activeVersion, 10)
  const nextActiveVer = (currentActiveVer + 1).toString()
  keyring.addKey(nextActiveVer, newKey)
  try {
    await storeVault(account, nextActiveVer)
  } catch (err) {
    keyring.removeKey(nextActiveVer)
    throw new Error(
      `Key rotation failed: keyring upload unsuccessful. Local state rolled back. Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
  keyring.setActiveVersion(nextActiveVer)
  broadcastVaultEvent({ type: 'KEY_ROTATED', account, keyVersion: nextActiveVer })
}

export async function enableBiometrics(account: string): Promise<void> {
  const currentKey = requireMasterKey()

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
  // Checked first: the server would reject the other account's key, which would read as a stale key
  // and clear this account's biometric unlock
  if (data.account && data.account !== account) {
    throw new Error('The biometric credential on this device belongs to another account')
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
  keyring.replace(new Map([['1', derivedKey]]), '1')
  keyHash = await hashVaultKey(derivedKey)

  // Phase 1: Load cached keyring for offline access
  let cachedKeyringLoaded = false
  const cachedKeyring = readCachedKeyring()
  if (cachedKeyring) {
    try {
      await loadKeyringFromEncrypted(cachedKeyring)
      cachedKeyringLoaded = true
    } catch {
      clearCachedKeyring()
    }
  }

  // Phase 2: Best-effort server session + keyring sync. As with a password login, a slow server
  // doesn't hold up unlocking once the cached keyring has loaded: the rest finishes in the background.
  const generation = keyGeneration
  const sessionAttempt = (async () => {
    await establishSessionFromKeyHash(account, keyHash)
    await syncKeyringFromServer(account)
  })().then(
    (): BiometricSessionOutcome => ({ error: undefined }),
    (error: unknown): BiometricSessionOutcome => ({ error }),
  )
  const outcome = cachedKeyringLoaded
    ? await Promise.race([sessionAttempt, serverWaitElapsed()])
    : await sessionAttempt

  if (!outcome) {
    console.info('[vault] The server is slow to respond; finishing the session in the background')
    void finishBiometricSessionInBackground(sessionAttempt, generation)
  } else if (outcome.error) {
    if (isUnauthorizedError(outcome.error)) {
      // The password was changed (or the key derivation upgraded) on another device, so the saved
      // key is stale. The cached keyring is wrapped with it too.
      clearKeyData()
      clearBiometricData()
      clearCachedKeyring()
      throw new StaleBiometricKeyError()
    }
    console.info('[vault] Biometric unlock in offline mode:', outcome.error)
  }

  const meta = readStoredMetadata()
  await writeStoredMetadata(account, {
    salt: meta?.salt,
    iterations: meta?.iterations,
    saltVersion: meta?.saltVersion,
  })
}

type BiometricSessionOutcome = { error: unknown }

async function finishBiometricSessionInBackground(attempt: Promise<BiometricSessionOutcome>, generation: number) {
  const { error } = await attempt
  if (generation !== keyGeneration) return
  if (!error) {
    notifyLateSession()
    return
  }
  if (isUnauthorizedError(error)) {
    // The saved key is stale (see unlockWithBiometrics). The session already started, so keep the
    // keys for working offline and ask the user to log in again.
    clearBiometricData()
    clearCachedKeyring()
    hostHooks.onSessionLost?.(
      'Sync paused: your password was changed on another device, so biometric unlock was turned off. '
      + 'Lock the app and log in with your new password to resume syncing.',
    )
    return
  }
  console.info('[vault] Biometric unlock in offline mode:', error)
}

/** Whether the server rejected a request's credentials (as opposed to a network failure) */
function isUnauthorizedError(err: unknown): boolean {
  let current: unknown = err
  while (current && typeof current === 'object') {
    if (current instanceof ApiHttpError && current.status === 401) return true
    if ((current as { data?: { code?: unknown } }).data?.code === 'UNAUTHORIZED') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
