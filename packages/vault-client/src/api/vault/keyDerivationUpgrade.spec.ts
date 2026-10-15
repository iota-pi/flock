import { TRPCClientError } from '@trpc/client'
import {
  clearVaultDeviceData,
  configureVaultHost,
  hasBiometricData,
  initialiseVault,
  loginVault,
  needsKeyDerivationUpgrade,
  readCachedKeyring,
  rotateVaultKey,
  StaleBiometricKeyError,
  storeVault,
  unlockWithBiometrics,
} from './index'
import { changePassword, getKeyring, getSession } from './client'
import { decryptWithKey, deriveVaultKey, encryptWithKey, exportVaultKey } from './crypto'
import { writeBiometricData } from './biometricStore'
import { ApiHttpError } from '../trackedFetch'

vi.mock('./client', () => ({
  getSession: vi.fn().mockResolvedValue('mock-session'),
  createAccount: vi.fn(),
  getSecurityParams: vi.fn(),
  getKeyring: vi.fn().mockResolvedValue(undefined),
  updateKeyring: vi.fn().mockResolvedValue(undefined),
  changePassword: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../sync/shared/workerAuthStore', () => ({
  setActiveSessionToken: vi.fn(),
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-session'),
  clearActiveSessionToken: vi.fn(),
}))

vi.mock('./util', async importOriginal => ({
  ...await importOriginal<typeof import('./util')>(),
  DEFAULT_CRYPTO_ITERATIONS: 1000,
}))

const PRF_OUTPUT = new Uint8Array(32).fill(7).buffer
vi.mock('./webauthn', () => ({
  getPrfOutput: vi.fn(async () => PRF_OUTPUT),
  registerPrfCredential: vi.fn(),
  isWebAuthnPrfSupported: vi.fn(),
}))

const ACCOUNT = 'test-account'
const PASSWORD = 'password123'
const LEGACY_SALT = 'bGVnYWN5LXNhbHQ='
const decodeLegacySalt = (salt: string) => new TextEncoder().encode(salt).buffer

/** Builds the server's keyring for an account whose master key comes from these parameters */
async function seedServerKeyring(params: { salt: string, iterations: number, saltVersion?: number }) {
  await initialiseVault({ password: PASSWORD, ...params })
  await storeVault(ACCOUNT)
  await rotateVaultKey(ACCOUNT)
  const keyring = readCachedKeyring()!
  await clearVaultDeviceData()
  vi.clearAllMocks()
  vi.mocked(getKeyring).mockResolvedValue(keyring)
}

describe('key derivation upgrade at login', () => {
  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({ decodeLegacySalt })
    await clearVaultDeviceData()
    vi.clearAllMocks()
    vi.mocked(getKeyring).mockResolvedValue(undefined)
    vi.mocked(getSession).mockResolvedValue('mock-session')
  })

  it('re-wraps every key under a current salt after logging in with a legacy salt', async () => {
    await seedServerKeyring({ salt: LEGACY_SALT, iterations: 1000 })

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 })

    expect(result).toEqual({ keyDerivationUpgraded: true, biometricsCleared: false })
    expect(changePassword).toHaveBeenCalledTimes(1)
    const request = vi.mocked(changePassword).mock.calls[0][0]
    expect(request).toMatchObject({
      account: ACCOUNT,
      saltVersion: 1,
      newIterations: 1000,
      expectedKeyringVersion: 2,
      keyringVersion: 2,
    })
    expect(request.newSalt).not.toBe(LEGACY_SALT)

    const newMasterKey = await deriveVaultKey({
      password: PASSWORD,
      salt: request.newSalt,
      iterations: request.newIterations,
      saltVersion: 1,
    })
    const keyring = JSON.parse(await decryptWithKey(newMasterKey, JSON.parse(request.newKeyring)))
    expect(keyring.activeVersion).toBe('2')
    expect(Object.keys(keyring).sort()).toEqual(['1', '2', 'activeVersion'])

    // The new session comes from the new credentials, and the device remembers the new salt
    expect(getSession).toHaveBeenLastCalledWith(ACCOUNT, request.newAuthToken)
    expect(JSON.parse(localStorage.getItem('test-vault-meta')!)).toMatchObject({
      salt: request.newSalt,
      iterations: 1000,
      saltVersion: 1,
    })
  })

  it('upgrades accounts with fewer iterations than the default', async () => {
    const salt = 'Y3VycmVudC1zYWx0'
    await seedServerKeyring({ salt, iterations: 500, saltVersion: 1 })

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt, iterations: 500, saltVersion: 1 })

    expect(result.keyDerivationUpgraded).toBe(true)
    expect(changePassword).toHaveBeenCalledTimes(1)
  })

  it('leaves current key derivation alone', async () => {
    const salt = 'Y3VycmVudC1zYWx0'
    await seedServerKeyring({ salt, iterations: 1000, saltVersion: 1 })

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt, iterations: 1000, saltVersion: 1 })

    expect(result).toEqual({ keyDerivationUpgraded: false, biometricsCleared: false })
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('does not upgrade offline', async () => {
    await initialiseVault({ password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 })
    await storeVault(ACCOUNT)
    vi.clearAllMocks()
    vi.mocked(getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 })

    expect(result.keyDerivationUpgraded).toBe(false)
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('does not upgrade without the server keyring, which may hold keys this device lacks', async () => {
    vi.mocked(getKeyring).mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 })

    expect(result.keyDerivationUpgraded).toBe(false)
    expect(changePassword).not.toHaveBeenCalled()
  })

  it('still logs in when the upgrade fails', async () => {
    await seedServerKeyring({ salt: LEGACY_SALT, iterations: 1000 })
    vi.mocked(changePassword).mockRejectedValueOnce(new Error('CONFLICT'))

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 })

    expect(result.keyDerivationUpgraded).toBe(false)
    expect(JSON.parse(localStorage.getItem('test-vault-meta')!)).toMatchObject({ salt: LEGACY_SALT })
  })

  it('reports that biometric unlock was cleared', async () => {
    await seedServerKeyring({ salt: LEGACY_SALT, iterations: 1000 })
    writeBiometricData({ account: ACCOUNT, credentialId: 'cred', prfSalt: 'salt', encryptedMasterKey: { iv: '', cipher: '' } })

    const result = await loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 })

    expect(result).toEqual({ keyDerivationUpgraded: true, biometricsCleared: true })
    expect(hasBiometricData()).toBe(false)
  })

  it('rejects legacy salts when the host supplies no decoder', async () => {
    configureVaultHost({})
    await expect(loginVault({ account: ACCOUNT, password: PASSWORD, salt: LEGACY_SALT, iterations: 1000 }))
      .rejects.toThrow(/Unsupported salt version/)
  })

  it('decides which parameters need upgrading', () => {
    expect(needsKeyDerivationUpgrade({ saltVersion: 1, iterations: 1000 })).toBe(false)
    expect(needsKeyDerivationUpgrade({ saltVersion: 1, iterations: 999 })).toBe(true)
    expect(needsKeyDerivationUpgrade({ saltVersion: 1 })).toBe(true)
    expect(needsKeyDerivationUpgrade({ iterations: 1000 })).toBe(true)
  })
})

describe('biometric unlock with a stale key', () => {
  beforeEach(async () => {
    localStorage.clear()
    configureVaultHost({})
    await clearVaultDeviceData()
    vi.clearAllMocks()
    vi.mocked(getKeyring).mockResolvedValue(undefined)

    // Save biometric unlock for a master key, along with a keyring wrapped with it
    const params = { password: PASSWORD, salt: 'Y3VycmVudC1zYWx0', iterations: 1000, saltVersion: 1 }
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

  it('unlocks offline when the server is unreachable', async () => {
    vi.mocked(getSession).mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(unlockWithBiometrics(ACCOUNT)).resolves.toBeUndefined()

    expect(hasBiometricData()).toBe(true)
    expect(readCachedKeyring()).not.toBeNull()
  })
})
