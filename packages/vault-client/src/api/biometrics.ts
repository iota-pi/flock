import { createLogger } from '../sync/utils/logger'
import { SESSION_REJECTED_CODE, SESSION_REJECTED_STATUS } from '../sync/utils/errorClassifier'
import { clearBiometricData, readBiometricData, writeBiometricData } from './biometricStore'
import { decryptWithKey, encryptWithKey, exportVaultKey, hashVaultKey, importVaultKey } from './crypto'
import { clearCachedKeyring, loadCachedKeyring } from './keyringCache'
import {
  assertKeyringLoaded,
  attemptSession,
  clearKeyData,
  establishSessionFromKeyHash,
  notifyLateSession,
} from './session'
import { readStoredMetadata, writeStoredMetadata } from './storedMetadata'
import { ApiHttpError } from './trackedFetch'
import { syncKeyringFromServer } from './vault'
import { getHostHooks } from './vaultHost'
import { vaultKeys } from './VaultKeyState'
import { getPrfOutput, registerPrfCredential } from './webauthn'

const log = createLogger('biometrics')

export class StaleBiometricKeyError extends Error {
  constructor() {
    super('The key saved for biometric unlock no longer matches the account')
    this.name = 'StaleBiometricKeyError'
  }
}

/** The key that wraps the master key for biometric unlock, from the credential's PRF output */
function importPrfKey(prfOutput: BufferSource): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    prfOutput,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function enableBiometrics(account: string): Promise<void> {
  const currentKey = vaultKeys.requireMasterKey()

  const { credentialId, prfSalt, prfOutput } = await registerPrfCredential(account)
  const prfKey = await importPrfKey(prfOutput)

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

type BiometricSessionOutcome = { error: unknown }

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
  const prfKey = await importPrfKey(prfOutput)

  const exportedMasterKey = await decryptWithKey(prfKey, {
    iv: data.encryptedMasterKey.iv,
    cipher: data.encryptedMasterKey.cipher,
  })

  const derivedKey = await importVaultKey(exportedMasterKey)
  // The stored parameters may be another account's (whoever logged in last). Only this account's
  // say it's PBKDF2; otherwise its keys come from the cache or the server, never the master key.
  const meta = readStoredMetadata()
  vaultKeys.setMasterKey(derivedKey, meta?.account === account && !meta.kdf)
  vaultKeys.keyHash = await hashVaultKey(derivedKey)

  // Phase 1: Load cached keyring for offline access
  const cachedKeyringLoaded = await loadCachedKeyring()

  // Phase 2: Best-effort server session + keyring sync, as with a password login
  const outcome = await attemptSession(
    () => establishSessionFromKeyHash(account, vaultKeys.keyHash)
      .then(() => syncKeyringFromServer(account, { retry: !vaultKeys.keyring.hasKey() }))
      .then(
        (): BiometricSessionOutcome => ({ error: undefined }),
        (error: unknown): BiometricSessionOutcome => ({ error }),
      ),
    { canWaitLess: cachedKeyringLoaded, finishLate: finishLateBiometricSession },
  )

  if (outcome?.error) {
    if (isUnauthorizedError(outcome.error)) {
      // The password was changed (or the key derivation upgraded) on another device, so the saved
      // key is stale. The cached keyring is wrapped with it too.
      clearKeyData()
      clearBiometricData()
      clearCachedKeyring()
      throw new StaleBiometricKeyError()
    }
    log.info('Biometric unlock in offline mode:', outcome.error)
  }
  assertKeyringLoaded()

  writeStoredMetadata(account)
}

function finishLateBiometricSession({ error }: BiometricSessionOutcome) {
  if (!error) {
    notifyLateSession()
    return
  }
  if (isUnauthorizedError(error)) {
    // The saved key is stale (see unlockWithBiometrics). The session already started, so keep the
    // keys for working offline and ask the user to log in again.
    clearBiometricData()
    clearCachedKeyring()
    getHostHooks().onSessionLost?.(
      'Sync paused: your password was changed on another device, so biometric unlock was turned off. '
      + 'Lock the app and log in with your new password to resume syncing.',
    )
    return
  }
  log.info('Biometric unlock in offline mode:', error)
}

/**
 * Whether the server rejected a request's credentials (as opposed to a network failure). Stricter
 * than `classifySyncError().isAuth` on purpose: a match clears the saved key and cached keyring,
 * and a 403 can only come from something between us and the server (such as a captive portal).
 */
function isUnauthorizedError(err: unknown): boolean {
  let current: unknown = err
  while (current && typeof current === 'object') {
    if (current instanceof ApiHttpError && current.status === SESSION_REJECTED_STATUS) return true
    if ((current as { data?: { code?: unknown } }).data?.code === SESSION_REJECTED_CODE) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}
