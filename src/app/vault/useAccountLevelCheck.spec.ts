import { renderHook, waitFor } from '@testing-library/react'
import { getOnlineState, getSecurityParams } from '@vault/client'
import useAccountLevelCheck, { checkAccountLevel } from './useAccountLevelCheck'
import { lockVault } from './session'
import { goToMigration } from '../../migrate/detection'
import * as clientModule from '@vault/client'
import * as sessionModule from './session'
import * as detectionModule from '../../migrate/detection'
import { spyOnExports } from '../../utils/testUtils'

const ARGON2ID = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }

beforeEach(() => {
  spyOnExports(clientModule, {
    getSecurityParams: vi.fn(),
    getOnlineState: vi.fn(() => true),
  })
  spyOnExports(sessionModule, {
    lockVault: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(detectionModule, {
    goToMigration: vi.fn(),
  })
})

describe('checkAccountLevel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('leaves a migrated account alone', async () => {
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 2 })

    await checkAccountLevel('acct-1')

    expect(lockVault).not.toHaveBeenCalled()
    expect(goToMigration).not.toHaveBeenCalled()
  })

  it('locks and sends an account below the minimum to the migration app', async () => {
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 1 })

    await checkAccountLevel('acct-1')

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(goToMigration).toHaveBeenCalledWith('acct-1')
  })

  it('lets an account below the minimum stay while its migration is deferred', async () => {
    localStorage.setItem('flock-migration-deferred', JSON.stringify({ 'acct-1': Date.now() + 60_000 }))
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', saltVersion: 1, kdf: ARGON2ID, dataVersion: 1 })

    await checkAccountLevel('acct-1')

    expect(goToMigration).not.toHaveBeenCalled()
  })

  it('always sends an account still on PBKDF2, even when deferred', async () => {
    localStorage.setItem('flock-migration-deferred', JSON.stringify({ 'acct-1': Date.now() + 60_000 }))
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', saltVersion: 1, iterations: 600_000, dataVersion: 2 })

    await checkAccountLevel('acct-1')

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(goToMigration).toHaveBeenCalledWith('acct-1')
  })

  it('does nothing when the server is unreachable', async () => {
    vi.mocked(getSecurityParams).mockRejectedValue(new TypeError('Failed to fetch'))

    await checkAccountLevel('acct-1')

    expect(lockVault).not.toHaveBeenCalled()
    expect(goToMigration).not.toHaveBeenCalled()
  })

  it('does nothing once cancelled', async () => {
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', saltVersion: 1, dataVersion: 1 })

    await checkAccountLevel('acct-1', () => true)

    expect(goToMigration).not.toHaveBeenCalled()
  })
})

describe('useAccountLevelCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getOnlineState).mockReturnValue(true)
    vi.mocked(getSecurityParams).mockResolvedValue({ salt: 'salt', saltVersion: 1, dataVersion: 1 })
  })

  it('checks after any unlock, including biometric unlock, once online', async () => {
    renderHook(() => useAccountLevelCheck('acct-1', true))

    await waitFor(() => expect(goToMigration).toHaveBeenCalledWith('acct-1'))
  })

  it('does not check while locked', async () => {
    renderHook(() => useAccountLevelCheck('acct-1', false))
    await Promise.resolve()

    expect(getSecurityParams).not.toHaveBeenCalled()
  })

  it('waits until the device is online', async () => {
    vi.mocked(getOnlineState).mockReturnValue(false)
    renderHook(() => useAccountLevelCheck('acct-1', true))
    await Promise.resolve()

    expect(getSecurityParams).not.toHaveBeenCalled()
  })
})
