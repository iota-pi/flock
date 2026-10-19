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
  type DeriveLegacyKey,
} from './crypto'
import { DEFAULT_KDF, setKdfWorkerFactory, type KdfParams } from './kdf'
import {
  broadcastVaultEvent,
  readStoredMetadata,
  VaultStoredMetadata,
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
  /**
   * Derives PBKDF2 keys, for accounts without Argon2id parameters. Without it, logging in to such
   * an account fails with `UnsupportedKeyDerivationError`.
   */
  deriveLegacyKey?: DeriveLegacyKey
  /**
   * Creates a worker that calls `exposeKdfWorker` (from `@vault/client/kdfWorker`), so Argon2id
   * runs off the main thread. Without it, Argon2id runs in the calling realm.
   */
  createKdfWorker?: () => Worker
}

let hostHooks: VaultHostHooks = {}
let vaultEventsListener: BroadcastChannel | null = null

/** Connects the vault to the host app. Call once at startup on the main thread. */
export function configureVaultHost(hooks: VaultHostHooks): void {
  hostHooks = hooks
  setKdfWorkerFactory(hooks.createKdfWorker)

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
// Whether the master key came from PBKDF2. On those accounts it is also data key v1 (see initialiseVault).
let masterKeyIsLegacy = false
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

type KeyDerivationParams = { salt?: string, iterations?: number, saltVersion?: number, kdf?: KdfParams }

/**
 * Records the account and, when given, its key derivation parameters. They're always given as a
 * set: a missing `kdf` means PBKDF2. Without them, the stored ones are kept.
 */
/**
 * What the server last said about the account's data keys. Login fetches the keyring before it
 * writes a new device's metadata, so the answer is kept until then.
 */
let lastKeyringAnswer: { account: string, randomDataKeys: boolean } | null = null

async function writeStoredMetadata(account: string, params?: KeyDerivationParams) {
  const stored = readStoredMetadata()
  const keyParams = params ?? stored
  // Learned from the server separately (see rememberRandomDataKeys), so a key derivation change keeps it
  const randomDataKeys = lastKeyringAnswer?.account === account
    ? lastKeyringAnswer.randomDataKeys || undefined
    : stored?.account === account ? stored.randomDataKeys : undefined
  localStorage.setItem(
    getVaultStorageNames().vaultMetadataKey,
    JSON.stringify({
      account,
      salt: keyParams?.salt,
      iterations: keyParams?.kdf ? undefined : keyParams?.iterations,
      saltVersion: keyParams?.saltVersion,
      kdf: keyParams?.kdf,
      randomDataKeys,
    } satisfies VaultStoredMetadata),
  )
}

/** Records what the server says about the account's data keys, for the sync worker to read at start */
function rememberRandomDataKeys(account: string, randomDataKeys: boolean) {
  lastKeyringAnswer = { account, randomDataKeys }
  const stored = readStoredMetadata()
  if (stored?.account !== account || stored.randomDataKeys === (randomDataKeys || undefined)) return
  localStorage.setItem(
    getVaultStorageNames().vaultMetadataKey,
    JSON.stringify({ ...stored, randomDataKeys: randomDataKeys || undefined } satisfies VaultStoredMetadata),
  )
}

/** Whether the account's data keys are random, as this device last heard (see `VaultStoredMetadata`) */
export function hasRandomDataKeys(account: string): boolean {
  const stored = readStoredMetadata()
  return stored?.account === account && stored.randomDataKeys === true
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

/**
 * Derives the master key and its auth token. The keyring is loaded separately (from the cache or the
 * server), except on PBKDF2 accounts, whose data key v1 is the master key itself.
 */
export async function initialiseVault({
  password,
  kdf,
  iterations,
  salt,
  saltVersion,
}: {
  password: string,
  kdf?: KdfParams,
  iterations?: number,
  salt: string,
  saltVersion?: number,
}) {
  const derivedKey = await deriveVaultKey({
    password,
    salt,
    kdf,
    iterations,
    saltVersion,
    decodeLegacySalt: hostHooks.decodeLegacySalt,
    deriveLegacyKey: hostHooks.deriveLegacyKey,
  })
  setMasterKey(derivedKey, !kdf)
  keyHash = await hashVaultKey(derivedKey)
  return keyHash
}

/** Sets the master key, and on PBKDF2 accounts its role as data key v1 */
function setMasterKey(key: CryptoKey, isLegacy: boolean) {
  masterKey = key
  masterKeyIsLegacy = isLegacy
  if (isLegacy) {
    keyring.replace(new Map([['1', key]]), '1')
  } else {
    keyring.clear()
  }
}

/** Fails a login or unlock that ended up without any data keys, which can't decrypt anything */
function assertKeyringLoaded() {
  if (!keyring.hasKey()) {
    clearKeyData()
    throw new Error('Could not load your encryption keys. Check your connection and try again.')
  }
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
    const response = await getKeyring(account)
    encryptedKeyringStr = response.keyring
    rememberRandomDataKeys(account, response.randomDataKeys)
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
  } else if (masterKeyIsLegacy) {
    // Accounts from before keyrings were stored get one at their next login. Accounts created
    // since are created with one, so for them a missing keyring is an error.
    try {
      await storeVault(account)
    } catch (err) {
      console.warn('[vault] Failed to seed keyring to server (network error):', err)
    }
    return false
  } else {
    clearKeyData()
    throw new Error('The server has no keyring for this account')
  }
}

export async function loginVault({
  account,
  password,
  salt,
  kdf,
  iterations,
  saltVersion,
}: {
  account: string,
  password: string,
  salt: string,
  kdf?: KdfParams,
  iterations?: number,
  saltVersion?: number,
}): Promise<{ keyDerivationUpgraded: boolean, biometricsCleared: boolean }> {
  await initialiseVault({ password, salt, kdf, iterations, saltVersion })

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
  assertKeyringLoaded()

  await writeStoredMetadata(account, { salt, iterations, saltVersion, kdf })

  // Upgrade outdated Argon2id parameters by changing the password to itself. The re-wrapped keyring
  // must hold every key, so this waits until the server's keyring has been loaded.
  if (serverKeyringLoaded && needsKeyDerivationUpgrade({ saltVersion, kdf })) {
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

/**
 * Whether an Argon2id key derived with these parameters should be re-derived with the current ones
 * at the next login. PBKDF2 accounts never are: they move to Argon2id in the app's migration, with
 * a new password, since the old one's PBKDF2 output outlives the change (see `upgradeKeyDerivation`).
 */
export function needsKeyDerivationUpgrade(
  { saltVersion, kdf }: { saltVersion?: number, kdf?: KdfParams },
): boolean {
  if (!kdf) return false
  return saltVersion !== CURRENT_SALT_VERSION
    || kdf.memoryKiB < DEFAULT_KDF.memoryKiB
    || kdf.passes < DEFAULT_KDF.passes
    || kdf.parallelism < DEFAULT_KDF.parallelism
}

/** Exports the keyring as JSON, for the sync worker's `Keyring.load` */
export async function exportKeyringData(): Promise<string> {
  return JSON.stringify(await keyring.export())
}

export async function storeVault(account: string, activeVersionOverride?: string) {
  const effectiveVersion = activeVersionOverride ?? keyring.activeVersion
  await writeStoredMetadata(account)
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
  masterKeyIsLegacy = false
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
    kdf: currentKdf,
    iterations: currentIterations,
    saltVersion: currentSaltVersion,
  } = await getSecurityParams(account)
  const currentMasterKey = await deriveVaultKey({
    password: currentPassword,
    salt: currentSalt,
    kdf: currentKdf,
    iterations: currentIterations,
    saltVersion: currentSaltVersion,
    decodeLegacySalt: hostHooks.decodeLegacySalt,
    deriveLegacyKey: hostHooks.deriveLegacyKey,
  })
  const currentAuthToken = await hashVaultKey(currentMasterKey)
  await rewrapMasterKey({ account, currentAuthToken, newPassword })
}

/**
 * Derives a new master key from `newPassword` with a fresh salt and the current Argon2id
 * parameters, re-wraps the keyring with it and replaces the account's credentials. This signs out
 * every other session and clears biometric unlock on this device.
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
  const newKdf = DEFAULT_KDF
  const newSaltVersion = CURRENT_SALT_VERSION

  const newMasterKey = await deriveVaultKey({
    password: newPassword,
    salt: newSalt,
    kdf: newKdf,
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
    newKdf,
    newKeyring: JSON.stringify(encryptedKeyring),
    saltVersion: newSaltVersion,
    expectedKeyringVersion: currentKeyringVer,
    keyringVersion: currentKeyringVer,
  })

  // The keyring keeps every data key, including a PBKDF2 account's v1, so only the master key changes
  masterKey = newMasterKey
  masterKeyIsLegacy = false
  clearBiometricData()
  writeCachedKeyring(JSON.stringify(encryptedKeyring))
  await writeStoredMetadata(account, {
    salt: newSalt,
    kdf: newKdf,
    saltVersion: newSaltVersion,
  })
  await establishSessionFromKeyHash(account, newAuthToken)
  broadcastVaultEvent({ type: 'PASSWORD_CHANGED', account })
}

/**
 * Creates an account whose master key is derived with Argon2id and whose data key is random, so no
 * data is ever encrypted with a key derived from the password. Returns the new account ID. The
 * vault isn't unlocked: log in afterwards.
 */
export async function createVaultAccount(password: string): Promise<string> {
  const salt = generateSalt()
  const kdf = DEFAULT_KDF
  const newMasterKey = await deriveVaultKey({ password, salt, kdf, saltVersion: CURRENT_SALT_VERSION })
  const authToken = await hashVaultKey(newMasterKey)

  const newKeyring = new Keyring()
  newKeyring.replace(new Map([['1', await generateVaultKey()]]), '1')
  const encryptedKeyring = await encryptWithKey(newMasterKey, JSON.stringify(await newKeyring.export()), 'master')

  const { account } = await createAccount({
    salt,
    authToken,
    saltVersion: CURRENT_SALT_VERSION,
    kdf,
    keyring: JSON.stringify(encryptedKeyring),
    randomDataKeys: true,
  })
  return account
}

/**
 * Moves a logged-in PBKDF2 account to Argon2id with a new password. Run it in the app's migration,
 * with the session and server keyring the login loaded. The new password must differ from the old
 * one: the old one's PBKDF2 output survives in backups (auth token hashes and data key v1).
 */
export async function upgradeKeyDerivation(account: string, newPassword: string): Promise<void> {
  if (!session || !keyHash) {
    throw new Error('Changing the password needs a connection to the server. Please try again once you are online.')
  }
  await rewrapMasterKey({ account, currentAuthToken: keyHash, newPassword })
}

/** The version of the data key new data is encrypted with */
export function getActiveKeyVersion(): string {
  return keyring.activeVersion
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
  // The stored parameters may be another account's (whoever logged in last). Only this account's
  // say it's PBKDF2; otherwise its keys come from the cache or the server, never the master key.
  const meta = readStoredMetadata()
  setMasterKey(derivedKey, meta?.account === account && !meta.kdf)
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
  assertKeyringLoaded()

  await writeStoredMetadata(account)
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
