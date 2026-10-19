import {
  getActiveKeyVersion,
  getSecurityParams,
  lockVaultKeys,
  loginVault,
  reencryptAllItems,
  upgradeKeyDerivation,
} from '@vault/client'
import {
  beginSync,
  changeToArgon2id,
  finishMigration,
  isMigrationComplete,
  KeyDerivationDowngradeError,
  OfflineError,
  reencryptPasswordDerivedData,
  startMigration,
} from './migration'
import { MigrationBridge } from './migrationBridge'
import { clearLegacyLocalData } from './legacy/localData'

vi.mock('@vault/client', async importOriginal => ({
  ...await importOriginal<typeof import('@vault/client')>(),
  getSecurityParams: vi.fn(),
  loginVault: vi.fn(),
  lockVaultKeys: vi.fn(),
  upgradeKeyDerivation: vi.fn(),
  getActiveKeyVersion: vi.fn(),
  reencryptAllItems: vi.fn(),
}))

vi.mock('./migrationBridge', () => ({
  MigrationBridge: {
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    reencryptAllItems: vi.fn(),
  },
  setMigrationAccount: vi.fn(),
}))

vi.mock('./legacy/localData', () => ({
  clearLegacyLocalData: vi.fn().mockResolvedValue(undefined),
}))

const ARGON2ID = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }

describe('migration', () => {
  const assign = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    vi.stubGlobal('location', { ...window.location, assign })
    vi.mocked(loginVault).mockResolvedValue({ keyDerivationUpgraded: false, biometricsCleared: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses to start offline', async () => {
    vi.mocked(getSecurityParams).mockRejectedValue(new Error('fetch failed'))

    await expect(startMigration('acct-1', 'password')).rejects.toBeInstanceOf(OfflineError)
    expect(loginVault).not.toHaveBeenCalled()
  })

  it('logs in a PBKDF2 account with its parameters and asks for a new password, before starting sync', async () => {
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', iterations: 100_000, saltVersion: 0, dataVersion: 0 })

    await expect(startMigration('acct-1', 'password')).resolves.toEqual({ needsNewPassword: true })

    expect(loginVault).toHaveBeenCalledWith({
      account: 'acct-1',
      password: 'password',
      salt: 'salt',
      iterations: 100_000,
      saltVersion: 0,
    })
    expect(MigrationBridge.initialize).not.toHaveBeenCalled()
  })

  it('needs no new password once the account is on Argon2id', async () => {
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 1 })

    await expect(startMigration('acct-1', 'password')).resolves.toEqual({ needsNewPassword: false })
    expect(loginVault).toHaveBeenCalledWith(expect.objectContaining({ kdf: ARGON2ID }))
  })

  it('refuses PBKDF2 parameters for an account this device knows uses Argon2id', async () => {
    localStorage.setItem('FlockVaultMeta', JSON.stringify({ account: 'acct-1', salt: 'salt', saltVersion: 1, kdf: ARGON2ID }))
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', iterations: 100_000, saltVersion: 1, dataVersion: 1 })

    await expect(startMigration('acct-1', 'password')).rejects.toBeInstanceOf(KeyDerivationDowngradeError)
    expect(loginVault).not.toHaveBeenCalled()
  })

  it('changes the password with the vault, then starts sync separately', async () => {
    await changeToArgon2id('acct-1', 'new-password')
    expect(upgradeKeyDerivation).toHaveBeenCalledWith('acct-1', 'new-password')
    expect(MigrationBridge.initialize).not.toHaveBeenCalled()

    await beginSync('acct-1')
    expect(MigrationBridge.initialize).toHaveBeenCalledWith('acct-1')
  })

  it('rotates off the password-derived key before re-encrypting', async () => {
    vi.mocked(getActiveKeyVersion).mockReturnValue('1')
    vi.mocked(reencryptAllItems).mockResolvedValue({ succeeded: [], failed: [] })
    const onProgress = vi.fn()

    await reencryptPasswordDerivedData('acct-1', onProgress)

    expect(reencryptAllItems).toHaveBeenCalledWith(MigrationBridge, 'acct-1', onProgress)
    expect(MigrationBridge.reencryptAllItems).not.toHaveBeenCalled()
  })

  it('only re-encrypts once a random key is already active', async () => {
    vi.mocked(getActiveKeyVersion).mockReturnValue('2')
    vi.mocked(MigrationBridge.reencryptAllItems).mockResolvedValue({ succeeded: [], failed: [] })
    const onProgress = vi.fn()

    await reencryptPasswordDerivedData('acct-1', onProgress)

    expect(MigrationBridge.reencryptAllItems).toHaveBeenCalledWith(onProgress)
    expect(reencryptAllItems).not.toHaveBeenCalled()
  })

  it('cleans up, locks and returns to the main app', async () => {
    await finishMigration('acct-1')

    expect(clearLegacyLocalData).toHaveBeenCalledWith('acct-1')
    expect(MigrationBridge.shutdown).toHaveBeenCalledWith({ clearLocalData: false, accountId: 'acct-1' })
    expect(lockVaultKeys).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/')
  })

  it('is complete once each level reaches its minimum', () => {
    expect(isMigrationComplete({ device: 3, account: 2, blockers: [] })).toBe(true)
    expect(isMigrationComplete({ device: 3, account: 1, blockers: ['legacyKeyDerivation'] })).toBe(false)
    // A device whose local data isn't sealed yet
    expect(isMigrationComplete({ device: 2, account: 2, blockers: [] })).toBe(false)
  })
})
