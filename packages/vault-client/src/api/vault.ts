import { deleteStoredSessionToken } from '../sync/shared/workerAuthStore'
import { clearManualRecoveryEntries } from '../sync/shared/manualRecoveryStore'
import {
  createAccount,
  getSecurityParams,
  getKeyring,
  updateKeyring,
  changePassword as changePasswordClient,
} from './client'
import {
  encryptWithKey,
  hashVaultKey,
  generateSalt,
  generateVaultKey,
  CURRENT_SALT_VERSION,
  type CryptoResult,
} from './crypto'
import { DEFAULT_KDF, type KdfParams } from './kdf'
import { broadcastVaultEvent } from './util'
import { retryTransientFailures } from './requestRetry'
import { clearWriteAheadLog } from '../sync/client/localDataCleanup'
import { clearBiometricData, hasBiometricData } from './biometricStore'
import { isRateLimitedError } from '@vault/shared'
import { Keyring } from './Keyring'
import { createLogger } from '../sync/utils/logger'
import { clearCachedKeyring, loadCachedKeyring, readCachedKeyring, writeCachedKeyring } from './keyringCache'
import { clearStoredMetadata, rememberRandomDataKeys, writeStoredMetadata } from './storedMetadata'
import {
  assertKeyringLoaded,
  attemptSession,
  clearKeyData,
  establishSessionFromKeyHash,
  notifyLateSession,
} from './session'
import { deriveMasterKey } from './vaultHost'
import { vaultKeys } from './VaultKeyState'

const log = createLogger('vault')

const { keyring } = vaultKeys

export interface VaultImportExportData {
  key: string,
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
    log.warn('Failed to decrypt cached keyring with current masterKey:', err)
    return { success: false, passwordChanged: true }
  }
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
  const derivedKey = await deriveMasterKey({ password, salt, kdf, iterations, saltVersion })
  vaultKeys.setMasterKey(derivedKey, !kdf)
  vaultKeys.keyHash = await hashVaultKey(derivedKey)
  return vaultKeys.keyHash
}

export function loadKeyringFromEncrypted(encryptedKeyringStr: string): Promise<void> {
  return vaultKeys.loadEncryptedKeyring(encryptedKeyringStr)
}

/**
 * Fetches the keyring, retrying transient failures. For unlocks with no other keys, which fail if
 * this one request is lost.
 */
function getKeyringWithRetry(account: string) {
  const generation = vaultKeys.currentGeneration
  return retryTransientFailures('retrieve keyring', () => getKeyring(account), {
    stillWanted: () => vaultKeys.isCurrent(generation),
  })
}

/**
 * Loads the server's keyring. Returns whether it was loaded (rather than missing or unreachable).
 * With `retry`, transient failures are retried before giving up.
 */
export async function syncKeyringFromServer(account: string, { retry = false } = {}): Promise<boolean> {
  let encryptedKeyringStr: string | undefined
  try {
    const response = retry ? await getKeyringWithRetry(account) : await getKeyring(account)
    encryptedKeyringStr = response.keyring
    rememberRandomDataKeys(account, response.randomDataKeys)
  } catch (err) {
    log.warn('Failed to retrieve keyring from server (network error):', err)
    return false
  }

  if (encryptedKeyringStr) {
    try {
      await loadKeyringFromEncrypted(encryptedKeyringStr)
      writeCachedKeyring(encryptedKeyringStr)
      return true
    } catch (err) {
      clearKeyData()
      log.error('Failed to decrypt keyring from server during login:', err)
      throw new Error(
        `Failed to decrypt keyring from server during login: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
  } else if (vaultKeys.masterKeyIsLegacy) {
    // Accounts from before keyrings were stored get one at their next login. Accounts created
    // since are created with one, so for them a missing keyring is an error.
    try {
      await storeVault(account)
    } catch (err) {
      log.warn('Failed to seed keyring to server (network error):', err)
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

  // Phase 1: Load cached keyring for offline operation
  const cachedKeyringLoaded = await loadCachedKeyring()

  // Phase 2: Best-effort server session
  let sessionError: unknown
  const sessionEstablished = await attemptSession(
    () => establishSessionFromKeyHash(account, vaultKeys.keyHash).then(
      () => true,
      (err: unknown) => {
        sessionError = err
        log.info('Operating in offline mode — sync deferred:', err)
        return false
      },
    ),
    {
      canWaitLess: cachedKeyringLoaded,
      finishLate: async established => {
        if (!established) return
        const generation = vaultKeys.currentGeneration
        try {
          await syncKeyringFromServer(account)
        } catch (err) {
          log.warn('Failed to sync the keyring after a late session:', err)
          return
        }
        if (vaultKeys.isCurrent(generation)) {
          notifyLateSession()
        }
      },
    },
  )

  if (!cachedKeyringLoaded && !sessionEstablished) {
    clearKeyData()
    // Says nothing about the password, so the caller can tell the user to wait (see `isRateLimitedError`)
    if (isRateLimitedError(sessionError)) {
      throw sessionError
    }
    throw new Error('Incorrect password. Please try again.')
  }

  // If session was established, sync latest keyring from server. Without the cache's keys (as on a
  // new device) the login fails unless this loads, so it's retried.
  const serverKeyringLoaded = sessionEstablished
    ? await syncKeyringFromServer(account, { retry: !keyring.hasKey() })
    : false
  assertKeyringLoaded()

  writeStoredMetadata(account, { salt, iterations, saltVersion, kdf })

  // Upgrade outdated Argon2id parameters by changing the password to itself. The re-wrapped keyring
  // must hold every key, so this waits until the server's keyring has been loaded.
  if (serverKeyringLoaded && needsKeyDerivationUpgrade({ saltVersion, kdf })) {
    const hadBiometrics = hasBiometricData()
    try {
      await rewrapMasterKey({ account, currentAuthToken: vaultKeys.keyHash, newPassword: password })
      return { keyDerivationUpgraded: true, biometricsCleared: hadBiometrics }
    } catch (err) {
      log.warn('Failed to upgrade key derivation; will retry at the next login:', err)
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
  writeStoredMetadata(account)
  const plaintext = JSON.stringify(await keyring.export(effectiveVersion))
  const encrypted = await encryptWithKey(vaultKeys.requireMasterKey(), plaintext, 'master')
  const encryptedStr = JSON.stringify(encrypted)

  if (vaultKeys.session) {
    const currentVer = parseInt(effectiveVersion, 10)
    const expectedVer = Math.max(currentVer - 1, 1)
    await updateKeyring({
      account,
      currentAuthToken: vaultKeys.keyHash,
      keyring: encryptedStr,
      expectedKeyringVersion: expectedVer,
      keyringVersion: currentVer,
    })
  }

  writeCachedKeyring(encryptedStr)
}

/**
 * Removes every trace of the vault from this device: keys, the session, cached keyring, biometric
 * unlock data and stored metadata, plus the account's WAL and manual recovery entries. Shut the sync
 * worker down (clearing its local data) before calling this.
 */
export async function clearVaultDeviceData(account?: string) {
  if (account) {
    await clearWriteAheadLog(account)
    await clearManualRecoveryEntries(account)
  }
  clearKeyData()
  clearBiometricData()
  clearCachedKeyring()
  await deleteStoredSessionToken()
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
  const { salt, kdf, iterations, saltVersion } = await getSecurityParams(account)
  const currentMasterKey = await deriveMasterKey({ password: currentPassword, salt, kdf, iterations, saltVersion })
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

  const newMasterKey = await deriveMasterKey({
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
  vaultKeys.rewrapMasterKey(newMasterKey)
  clearBiometricData()
  writeCachedKeyring(JSON.stringify(encryptedKeyring))
  writeStoredMetadata(account, {
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
  const newMasterKey = await deriveMasterKey({ password, salt, kdf, saltVersion: CURRENT_SALT_VERSION })
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
  if (!vaultKeys.session || !vaultKeys.keyHash) {
    throw new Error('Changing the password needs a connection to the server. Please try again once you are online.')
  }
  await rewrapMasterKey({ account, currentAuthToken: vaultKeys.keyHash, newPassword })
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
  if (!vaultKeys.session) {
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
