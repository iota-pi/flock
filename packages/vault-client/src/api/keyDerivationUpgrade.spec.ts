import { TRPCClientError } from '@trpc/client'
import {
  clearVaultDeviceData,
  createVaultAccount,
  exportKeyringData,
  getActiveKeyVersion,
  hasVaultKey,
  initialiseVault,
  loginVault,
  needsKeyDerivationUpgrade,
  rotateVaultKey,
  storeVault,
  upgradeKeyDerivation,
} from './vault'
import { establishSessionFromKeyHash, lockVaultKeys, onLateSession } from './session'
import { StaleBiometricKeyError, unlockWithBiometrics } from './biometrics'
import { hasBiometricData, writeBiometricData } from './biometricStore'
import { readCachedKeyring } from './keyringCache'
import { hasRandomDataKeys, readStoredMetadata } from './storedMetadata'
import { configureVaultHost } from './vaultHost'
import { changePassword, createAccount, getKeyring, getSession, updateKeyring } from './client'
import { decryptWithKey, deriveVaultKey, encryptWithKey, exportVaultKey, generateVaultKey } from './crypto'
import { Keyring } from './Keyring'
import { ApiHttpError } from './trackedFetch'
import type { KdfParams } from './kdf'
import { deriveLegacyKey } from '../../test/deriveLegacyKey'

vi.mock('./client', () => ({
  getSession: vi.fn().mockResolvedValue('mock-session'),
  createAccount: vi.fn(),
  getSecurityParams: vi.fn(),
  getKeyring: vi.fn().mockResolvedValue({ randomDataKeys: false }),
  updateKeyring: vi.fn().mockResolvedValue(undefined),
  changePassword: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../sync/shared/workerAuthStore', () => ({
  deleteStoredSessionToken: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./util', async importOriginal => ({
  ...await importOriginal<typeof import('./util')>(),
  DEFAULT_CRYPTO_ITERATIONS: 1000,
  REQUEST_RETRY_DELAYS: [0, 0],
}))

// Current parameters above the test floor, so an account can be created below them
vi.mock('./kdf', async importOriginal => ({
  ...await importOriginal<typeof import('./kdf')>(),
  DEFAULT_KDF: { algorithm: 'argon2id', memoryKiB: 16, passes: 1, parallelism: 1 },
}))

const PRF_OUTPUT = new Uint8Array(32).fill(7).buffer
vi.mock('./webauthn', () => ({
  getPrfOutput: vi.fn(async () => PRF_OUTPUT),
  registerPrfCredential: vi.fn(),
  isWebAuthnPrfSupported: vi.fn(),
}))

const ACCOUNT = 'test-account'
const PASSWORD = 'password123'
const SALT = 'Y3VycmVudC1zYWx0'
const LEGACY_SALT = 'bGVnYWN5LXNhbHQ='
const decodeLegacySalt = (salt: string) => new TextEncoder().encode(salt).buffer
const CURRENT_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 16, passes: 1, parallelism: 1 }
const OLD_KDF: KdfParams = { algorithm: 'argon2id', memoryKiB: 8, passes: 1, parallelism: 1 }

/** Builds the server's keyring for a PBKDF2 account, whose v1 is the master key, rotated once */
async function seedLegacyServerKeyring(params: { salt: string, iterations: number, saltVersion?: number }) {
  const keyHash = await initialiseVault({ password: PASSWORD, ...params })
  await establishSessionFromKeyHash(ACCOUNT, keyHash)
  await storeVault(ACCOUNT)
  await rotateVaultKey(ACCOUNT)
  const keyring = readCachedKeyring()!
  await clearVaultDeviceData()
  vi.clearAllMocks()
  vi.mocked(getKeyring).mockResolvedValue({ keyring, randomDataKeys: false })
}

/** Builds the server's keyring for an Argon2id account: a random v1 wrapped with the master key */
async function seedArgon2idServerKeyring(kdf: KdfParams) {
  const masterKey = await deriveVaultKey({ password: PASSWORD, salt: SALT, kdf, saltVersion: 1 })
  const keys = new Keyring()
  keys.replace(new Map([['1', await generateVaultKey()]]), '1')
  const keyring = JSON.stringify(await encryptWithKey(masterKey, JSON.stringify(await keys.export()), 'master'))
  vi.mocked(getKeyring).mockResolvedValue({ keyring, randomDataKeys: false })
  return { masterKey, keyring }
}

function loginArgon2id(kdf: KdfParams) {
  return loginVault({ account: ACCOUNT, password: PASSWORD, salt: SALT, kdf, saltVersion: 1 })
}

describe('key derivation at login', () => {
  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({ decodeLegacySalt, deriveLegacyKey })
    await clearVaultDeviceData()
    vi.clearAllMocks()
    vi.mocked(getKeyring).mockResolvedValue({ randomDataKeys: false })
    vi.mocked(getSession).mockResolvedValue('mock-session')
  })

  it('reports a rate-limited login as such rather than as a wrong password', async () => {
    await seedArgon2idServerKeyring(CURRENT_KDF)
    const rateLimited = new TRPCClientError('TOO_MANY_REQUESTS')
    Object.assign(rateLimited, { data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 } })
    vi.mocked(getSession).mockRejectedValue(rateLimited)

    await expect(loginArgon2id(CURRENT_KDF)).rejects.toBe(rateLimited)
  })

  it('re-wraps every key under the current Argon2id parameters when the account\'s are older', async () => {
    await seedArgon2idServerKeyring(OLD_KDF)

    const result = await loginArgon2id(OLD_KDF)

    expect(result).toEqual({ keyDerivationUpgraded: true, biometricsCleared: false })
    expect(changePassword).toHaveBeenCalledTimes(1)
    const request = vi.mocked(changePassword).mock.calls[0][0]
    expect(request).toMatchObject({ account: ACCOUNT, saltVersion: 1, newKdf: CURRENT_KDF })
    expect(request).not.toHaveProperty('newIterations')
    expect(request.newSalt).not.toBe(SALT)

    const newMasterKey = await deriveVaultKey({ password: PASSWORD, salt: request.newSalt, kdf: request.newKdf, saltVersion: 1 })
    const keyring = JSON.parse(await decryptWithKey(newMasterKey, JSON.parse(request.newKeyring)))
    expect(Object.keys(keyring).sort()).toEqual(['1', 'activeVersion'])

    // The new session comes from the new credentials, and the device remembers the new parameters
    expect(getSession).toHaveBeenLastCalledWith(ACCOUNT, request.newAuthToken)
    expect(readStoredMetadata()).toMatchObject({ salt: request.newSalt, saltVersion: 1, kdf: CURRENT_KDF })
    expect(readStoredMetadata()?.iterations).toBeUndefined()
  })

  it("remembers whether the account's data keys are random, from a new device's first login", async () => {
    const { keyring } = await seedArgon2idServerKeyring(CURRENT_KDF)
    vi.mocked(getKeyring).mockResolvedValue({ keyring, randomDataKeys: true })

    await loginArgon2id(CURRENT_KDF)

    expect(readStoredMetadata()?.randomDataKeys).toBe(true)
    expect(hasRandomDataKeys(ACCOUNT)).toBe(true)
    expect(hasRandomDataKeys('another-account')).toBe(false)

    vi.mocked(getKeyring).mockResolvedValue({ keyring, randomDataKeys: false })
    await loginArgon2id(CURRENT_KDF)

    expect(hasRandomDataKeys(ACCOUNT)).toBe(false)
  })

  it('leaves current Argon2id parameters alone', async () => {
    await seedArgon2idServerKeyring(CURRENT_KDF)

    const result = await loginArgon2id(CURRENT_KDF)

    expect(result).toEqual({ keyDerivationUpgraded: false, biometricsCleared: false })
    expect(changePassword).not.toHaveBeenCalled()
    expect(readStoredMetadata()).toMatchObject({ salt: SALT, kdf: CURRENT_KDF })
  })

  it('does not re-wrap PBKDF2 accounts, which move to Argon2id with a new password', async () => {
    await seedLegacyServerKeyring({ salt: LEGACY_SALT, iterations: 500 })

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 500 })

    expect(result).toEqual({ keyDerivationUpgraded: false, biometricsCleared: false })
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('never uses the master key as a data key on Argon2id accounts', async () => {
    const { masterKey } = await seedArgon2idServerKeyring(CURRENT_KDF)

    await loginArgon2id(CURRENT_KDF)

    const keys = JSON.parse(await exportKeyringData())
    expect(keys['1']).toBeDefined()
    expect(keys['1']).not.toBe(await exportVaultKey(masterKey))
  })

  it('fails an Argon2id login that could not load any keys', async () => {
    vi.mocked(getKeyring).mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(loginArgon2id(CURRENT_KDF)).rejects.toThrow('Could not load your encryption keys')
    expect(getKeyring).toHaveBeenCalledTimes(3)
    expect(getActiveKeyVersion()).toBe('1')
    await expect(exportKeyringData()).resolves.toBe('{"activeVersion":"1"}')
  })

  it('retries the keyring fetch when a login has no cached keys', async () => {
    await seedArgon2idServerKeyring(CURRENT_KDF)
    vi.mocked(getKeyring).mockRejectedValueOnce(new TypeError('Failed to fetch'))

    await loginArgon2id(CURRENT_KDF)

    expect(getKeyring).toHaveBeenCalledTimes(2)
    expect(hasVaultKey('1')).toBe(true)
  })

  it('doesn\'t retry a rate-limited keyring fetch', async () => {
    await seedArgon2idServerKeyring(CURRENT_KDF)
    const rateLimited = new TRPCClientError('TOO_MANY_REQUESTS')
    Object.assign(rateLimited, { data: { code: 'TOO_MANY_REQUESTS', httpStatus: 429 } })
    vi.mocked(getKeyring).mockRejectedValueOnce(rateLimited)

    await expect(loginArgon2id(CURRENT_KDF)).rejects.toThrow('Could not load your encryption keys')
    expect(getKeyring).toHaveBeenCalledTimes(1)
  })

  it('retries a server error but not a rejected session', async () => {
    await seedArgon2idServerKeyring(CURRENT_KDF)
    vi.mocked(getKeyring).mockRejectedValueOnce(new ApiHttpError({ status: 502, url: 'getKeyring' }))
    await loginArgon2id(CURRENT_KDF)
    expect(getKeyring).toHaveBeenCalledTimes(2)

    await lockVaultKeys()
    localStorage.clear()
    vi.mocked(getKeyring).mockClear()
    vi.mocked(getKeyring).mockRejectedValueOnce(new ApiHttpError({ status: 401, url: 'getKeyring' }))
    await expect(loginArgon2id(CURRENT_KDF)).rejects.toThrow('Could not load your encryption keys')
    expect(getKeyring).toHaveBeenCalledTimes(1)
  })

  it('doesn\'t delay a login whose cached keys already unlocked it', async () => {
    await seedArgon2idServerKeyring(CURRENT_KDF)
    await loginArgon2id(CURRENT_KDF)
    await lockVaultKeys()
    vi.mocked(getKeyring).mockClear()
    vi.mocked(getKeyring).mockRejectedValue(new TypeError('Failed to fetch'))

    await loginArgon2id(CURRENT_KDF)

    expect(getKeyring).toHaveBeenCalledTimes(1)
    expect(hasVaultKey('1')).toBe(true)
  })

  it('refuses an Argon2id account the server has no keyring for, rather than making one', async () => {
    await expect(loginArgon2id(CURRENT_KDF)).rejects.toThrow()
    expect(updateKeyring).not.toHaveBeenCalled()
  })

  it('still stores a keyring for a PBKDF2 account that never had one', async () => {
    await loginVault({ account: ACCOUNT, password: PASSWORD, salt: SALT, iterations: 1000, saltVersion: 1 })

    expect(updateKeyring).toHaveBeenCalledTimes(1)
    // Proves the master key with the same auth token the login sent
    const loginAuthToken = vi.mocked(getSession).mock.calls.at(-1)?.[1]
    expect(loginAuthToken).toBeTruthy()
    expect(updateKeyring).toHaveBeenCalledWith(expect.objectContaining({
      account: ACCOUNT,
      currentAuthToken: loginAuthToken,
    }))
  })

  it('does not upgrade offline', async () => {
    const { keyring } = await seedArgon2idServerKeyring(OLD_KDF)
    localStorage.setItem('test-vault-keyring-cache', keyring)
    vi.mocked(getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await loginArgon2id(OLD_KDF)

    expect(result.keyDerivationUpgraded).toBe(false)
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('still logs in when the upgrade fails', async () => {
    await seedArgon2idServerKeyring(OLD_KDF)
    vi.mocked(changePassword).mockRejectedValueOnce(new Error('CONFLICT'))

    const result = await loginArgon2id(OLD_KDF)

    expect(result.keyDerivationUpgraded).toBe(false)
    expect(readStoredMetadata()).toMatchObject({ salt: SALT, kdf: OLD_KDF })
  })

  it('reports that biometric unlock was cleared', async () => {
    await seedArgon2idServerKeyring(OLD_KDF)
    writeBiometricData({ account: ACCOUNT, credentialId: 'cred', prfSalt: 'salt', encryptedMasterKey: { iv: '', cipher: '' } })

    const result = await loginArgon2id(OLD_KDF)

    expect(result).toEqual({ keyDerivationUpgraded: true, biometricsCleared: true })
    expect(hasBiometricData()).toBe(false)
  })

  it('rejects legacy salts when the host supplies no decoder', async () => {
    configureVaultHost({ deriveLegacyKey })
    await expect(loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 }))
      .rejects.toThrow(/Unsupported salt version/)
  })

  it('decides which parameters need upgrading', () => {
    expect(needsKeyDerivationUpgrade({ saltVersion: 1, kdf: CURRENT_KDF })).toBe(false)
    expect(needsKeyDerivationUpgrade({ saltVersion: 1, kdf: OLD_KDF })).toBe(true)
    expect(needsKeyDerivationUpgrade({ saltVersion: 1, kdf: { ...CURRENT_KDF, passes: 0 } })).toBe(true)
    expect(needsKeyDerivationUpgrade({ kdf: CURRENT_KDF })).toBe(true)
    // PBKDF2 accounts move in the migration app instead
    expect(needsKeyDerivationUpgrade({ saltVersion: 1 })).toBe(false)
    expect(needsKeyDerivationUpgrade({})).toBe(false)
  })
})

describe('createVaultAccount', () => {
  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({})
    await clearVaultDeviceData()
    vi.clearAllMocks()
    vi.mocked(createAccount).mockResolvedValue({ account: ACCOUNT })
  })

  it('creates an Argon2id account whose data key is random, not derived from the password', async () => {
    await expect(createVaultAccount(PASSWORD)).resolves.toBe(ACCOUNT)

    const request = vi.mocked(createAccount).mock.calls[0][0]
    expect(request).toMatchObject({ saltVersion: 1, kdf: CURRENT_KDF, randomDataKeys: true })
    const masterKey = await deriveVaultKey({ password: PASSWORD, salt: request.salt, kdf: request.kdf, saltVersion: 1 })
    const keyring = JSON.parse(await decryptWithKey(masterKey, JSON.parse(request.keyring!)))
    expect(keyring.activeVersion).toBe('1')
    expect(keyring['1']).not.toBe(await exportVaultKey(masterKey))
  })

  it('leaves the vault locked', async () => {
    await createVaultAccount(PASSWORD)
    expect(readCachedKeyring()).toBeNull()
    expect(readStoredMetadata()).toBeNull()
  })
})

describe('upgradeKeyDerivation', () => {
  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({ deriveLegacyKey })
    await clearVaultDeviceData()
    vi.clearAllMocks()
    vi.mocked(getSession).mockResolvedValue('mock-session')
  })

  it('moves a PBKDF2 account to Argon2id, keeping every key including v1', async () => {
    await seedLegacyServerKeyring({ salt: SALT, iterations: 1000, saltVersion: 1 })
    await loginVault({ account: ACCOUNT, password: PASSWORD, salt: SALT, iterations: 1000, saltVersion: 1 })

    await upgradeKeyDerivation(ACCOUNT, 'new-password-456')

    const request = vi.mocked(changePassword).mock.calls[0][0]
    expect(request.newKdf).toEqual(CURRENT_KDF)
    const newMasterKey = await deriveVaultKey({ password: 'new-password-456', salt: request.newSalt, kdf: request.newKdf, saltVersion: 1 })
    const keyring = JSON.parse(await decryptWithKey(newMasterKey, JSON.parse(request.newKeyring)))
    expect(Object.keys(keyring).sort()).toEqual(['1', '2', 'activeVersion'])
    expect(readStoredMetadata()).toMatchObject({ kdf: CURRENT_KDF })
    expect(getActiveKeyVersion()).toBe('2')
  })

  it('needs a session', async () => {
    await initialiseVault({ password: PASSWORD, salt: SALT, iterations: 1000, saltVersion: 1 })

    await expect(upgradeKeyDerivation(ACCOUNT, 'new-password-456')).rejects.toThrow(/connection to the server/)
    expect(changePassword).not.toHaveBeenCalled()
  })
})

describe('biometric unlock with a stale key', () => {
  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({ deriveLegacyKey })
    await clearVaultDeviceData()
    vi.clearAllMocks()
    vi.mocked(getKeyring).mockResolvedValue({ randomDataKeys: false })

    // Save biometric unlock for a master key, along with a keyring wrapped with it
    const params = { password: PASSWORD, salt: 'Y3VycmVudC1zYWx0', iterations: 1000, saltVersion: 1, deriveLegacyKey }
    await initialiseVault(params)
    await storeVault(ACCOUNT)
    const masterKey = await deriveVaultKey(params)
    const prfKey = await crypto.subtle.importKey('raw', PRF_OUTPUT, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const encrypted = await encryptWithKey(prfKey, await exportVaultKey(masterKey), 'master')
    writeBiometricData({
      account: ACCOUNT,
      credentialId: 'cred',
      prfSalt: 'salt',
      encryptedMasterKey: { iv: encrypted.iv, cipher: encrypted.cipher },
    })
    vi.clearAllMocks()
  })

  it('clears biometric unlock and the cached keyring when the server rejects the key', async () => {
    vi.mocked(getSession).mockRejectedValue(
      new TRPCClientError('Server request failed (401)', { cause: new ApiHttpError({ status: 401, url: '/trpc' }) }),
    )

    await expect(unlockWithBiometrics(ACCOUNT)).rejects.toBeInstanceOf(StaleBiometricKeyError)

    expect(hasBiometricData()).toBe(false)
    expect(readCachedKeyring()).toBeNull()
  })

  it('refuses to unlock another account, keeping this one\'s biometric unlock', async () => {
    vi.mocked(getSession).mockRejectedValue(
      new TRPCClientError('Server request failed (401)', { cause: new ApiHttpError({ status: 401, url: '/trpc' }) }),
    )

    await expect(unlockWithBiometrics('other-account')).rejects.toThrow('belongs to another account')

    expect(getSession).not.toHaveBeenCalled()
    expect(hasBiometricData()).toBe(true)
    expect(readCachedKeyring()).not.toBeNull()
  })

  it('unlocks offline when the server is unreachable', async () => {
    vi.mocked(getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(unlockWithBiometrics(ACCOUNT)).resolves.toBeUndefined()

    expect(hasBiometricData()).toBe(true)
    expect(readCachedKeyring()).not.toBeNull()
  })

  describe('with a slow server', () => {
    const unauthorized = () => new TRPCClientError('Server request failed (401)', {
      cause: new ApiHttpError({ status: 401, url: '/trpc' }),
    })
    let respond: (session: string) => void
    let reject: (error: unknown) => void

    beforeEach(() => {
      vi.mocked(getSession).mockImplementationOnce(() => new Promise((resolve, rejectRequest) => {
        respond = resolve
        reject = rejectRequest
      }))
      vi.useFakeTimers({ toFake: ['setTimeout'] })
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    /** Runs timers until the promise settles, letting real crypto work progress in between */
    async function settle<T>(promise: Promise<T>): Promise<T> {
      let done = false
      promise.finally(() => { done = true }).catch(() => undefined)
      while (!done) {
        await new Promise(resolve => setImmediate(resolve))
        await vi.advanceTimersByTimeAsync(500)
      }
      return promise
    }

    it('unlocks with the cached keyring and finishes the session in the background', async () => {
      let notified: () => void = () => {}
      const lateSession = new Promise<void>(resolve => { notified = resolve })
      const listener = vi.fn(() => notified())
      const stopListening = onLateSession(listener)

      await settle(unlockWithBiometrics(ACCOUNT))
      expect(listener).not.toHaveBeenCalled()

      respond('late-session')
      await settle(lateSession)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(hasBiometricData()).toBe(true)
      stopListening()
    })

    it('turns off biometric unlock and reports a lost session when the server later rejects the key', async () => {
      const onSessionLost = vi.fn()
      configureVaultHost({ onSessionLost })

      await settle(unlockWithBiometrics(ACCOUNT))
      expect(hasBiometricData()).toBe(true)

      reject(unauthorized())
      await vi.waitFor(() => expect(onSessionLost).toHaveBeenCalledWith(expect.stringMatching(/password was changed/)))
      expect(hasBiometricData()).toBe(false)
      expect(readCachedKeyring()).toBeNull()
    })

    it('ignores a response that arrives after locking', async () => {
      const onSessionLost = vi.fn()
      configureVaultHost({ onSessionLost })

      await settle(unlockWithBiometrics(ACCOUNT))
      await lockVaultKeys()

      reject(unauthorized())
      await new Promise(resolve => setImmediate(resolve))
      expect(onSessionLost).not.toHaveBeenCalled()
      expect(hasBiometricData()).toBe(true)
    })
  })
})

describe('biometric unlock without a cached keyring', () => {
  async function saveBiometricUnlock(masterKey: CryptoKey) {
    const prfKey = await crypto.subtle.importKey('raw', PRF_OUTPUT, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const encrypted = await encryptWithKey(prfKey, await exportVaultKey(masterKey), 'master')
    writeBiometricData({
      account: ACCOUNT,
      credentialId: 'cred',
      prfSalt: 'salt',
      encryptedMasterKey: { iv: encrypted.iv, cipher: encrypted.cipher },
    })
  }

  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({ deriveLegacyKey })
    await clearVaultDeviceData()
    vi.clearAllMocks()
    vi.mocked(getKeyring).mockResolvedValue({ randomDataKeys: false })
    vi.mocked(getSession).mockRejectedValue(new TypeError('Failed to fetch'))
  })

  it('refuses to unlock an Argon2id account offline with no keys to load', async () => {
    const { masterKey } = await seedArgon2idServerKeyring(CURRENT_KDF)
    localStorage.setItem('test-vault-meta', JSON.stringify({ account: ACCOUNT, salt: SALT, saltVersion: 1, kdf: CURRENT_KDF }))
    await saveBiometricUnlock(masterKey)

    await expect(unlockWithBiometrics(ACCOUNT)).rejects.toThrow('Could not load your encryption keys')
  })

  it('never takes another account\'s stored parameters as a sign that this one is PBKDF2', async () => {
    const { masterKey } = await seedArgon2idServerKeyring(CURRENT_KDF)
    // The last login on this device was a different, PBKDF2 account
    localStorage.setItem('test-vault-meta', JSON.stringify({ account: 'other-account', salt: SALT, saltVersion: 1, iterations: 1000 }))
    await saveBiometricUnlock(masterKey)

    await expect(unlockWithBiometrics(ACCOUNT)).rejects.toThrow('Could not load your encryption keys')
  })

  it('still unlocks a PBKDF2 account offline, whose master key is data key v1', async () => {
    const masterKey = await deriveVaultKey({ password: PASSWORD, salt: SALT, iterations: 1000, saltVersion: 1, deriveLegacyKey })
    localStorage.setItem('test-vault-meta', JSON.stringify({ account: ACCOUNT, salt: SALT, saltVersion: 1, iterations: 1000 }))
    await saveBiometricUnlock(masterKey)

    await expect(unlockWithBiometrics(ACCOUNT)).resolves.toBeUndefined()
    expect(JSON.parse(await exportKeyringData())['1']).toBe(await exportVaultKey(masterKey))
  })
})
