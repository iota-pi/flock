import { getSecurityParams, lockVaultKeys, loginVault } from '@vault/client'
import { finishMigration, isMigrationComplete, OfflineError, startMigration } from './migration'
import { MigrationBridge } from './migrationBridge'
import { clearLegacyLocalData } from './legacy/localData'

vi.mock('@vault/client', async importOriginal => ({
  ...await importOriginal<typeof import('@vault/client')>(),
  getSecurityParams: vi.fn(),
  loginVault: vi.fn(),
  lockVaultKeys: vi.fn(),
}))

vi.mock('./migrationBridge', () => ({
  MigrationBridge: {
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
  setMigrationAccount: vi.fn(),
}))

vi.mock('./legacy/localData', () => ({
  clearLegacyLocalData: vi.fn().mockResolvedValue(undefined),
}))

describe('migration', () => {
  const assign = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('location', { ...window.location, assign })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refuses to start offline', async () => {
    vi.mocked(getSecurityParams).mockRejectedValue(new Error('fetch failed'))

    await expect(startMigration('acct-1', 'password')).rejects.toBeInstanceOf(OfflineError)
    expect(loginVault).not.toHaveBeenCalled()
  })

  it('logs in with the account\'s parameters, then starts sync', async () => {
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', iterations: 100, saltVersion: 0, dataVersion: 0 })
    vi.mocked(loginVault).mockResolvedValue({ keyDerivationUpgraded: true, biometricsCleared: false })

    await startMigration('acct-1', 'password')

    expect(loginVault).toHaveBeenCalledWith({
      account: 'acct-1',
      password: 'password',
      salt: 'salt',
      iterations: 100,
      saltVersion: 0,
    })
    expect(MigrationBridge.initialize).toHaveBeenCalledWith('acct-1')
  })

  it('cleans up, locks and returns to the main app', async () => {
    await finishMigration('acct-1')

    expect(clearLegacyLocalData).toHaveBeenCalledWith('acct-1')
    expect(MigrationBridge.shutdown).toHaveBeenCalledWith({ clearLocalData: false, accountId: 'acct-1' })
    expect(lockVaultKeys).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/')
  })

  it('is complete once both levels reach the minimum', () => {
    expect(isMigrationComplete({ device: 1, account: 1, blockers: [] })).toBe(true)
    expect(isMigrationComplete({ device: 1, account: 0, blockers: ['legacySettings'] })).toBe(false)
    expect(isMigrationComplete({ device: 0, account: 1, blockers: [] })).toBe(false)
  })
})
