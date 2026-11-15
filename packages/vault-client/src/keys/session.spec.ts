import type { MockInstance } from 'vitest'
import * as accountClient from './AccountClient'
import * as deviceToken from './deviceToken'
import { getApiAuthToken, setApiAuthToken } from './runtime'
import { clearKeyData, establishSessionFromKeyHash, lockVaultKeys } from './session'
import { vaultKeys } from './VaultKeyState'

describe('ending the session on the server', () => {
  let endSession: MockInstance<typeof accountClient.endSession>

  beforeEach(() => {
    vi.restoreAllMocks()
    endSession = vi.spyOn(accountClient, 'endSession').mockResolvedValue(undefined)
  })

  afterEach(() => {
    vaultKeys.clear()
    setApiAuthToken('')
  })

  it('ends the session when the keys are cleared', () => {
    vaultKeys.activeAccount = 'acct-1'
    setApiAuthToken('session-1')

    clearKeyData()

    expect(endSession).toHaveBeenCalledExactlyOnceWith('acct-1', 'session-1')
    expect(getApiAuthToken()).toBe('')
  })

  it('locks at once, without waiting for the server or failing when it can\'t be reached', async () => {
    endSession.mockReturnValue(new Promise(() => {}))
    vaultKeys.activeAccount = 'acct-1'
    setApiAuthToken('session-1')
    await lockVaultKeys()
    expect(getApiAuthToken()).toBe('')

    endSession.mockRejectedValue(new Error('offline'))
    vaultKeys.activeAccount = 'acct-1'
    setApiAuthToken('session-2')
    await expect(lockVaultKeys()).resolves.toBeUndefined()
    expect(endSession).toHaveBeenLastCalledWith('acct-1', 'session-2')
  })

  it('has nothing to end without a session', () => {
    vaultKeys.activeAccount = 'acct-1'
    clearKeyData()
    expect(endSession).not.toHaveBeenCalled()
  })

  it('ends a session that arrives after the vault was locked', async () => {
    vi.spyOn(deviceToken, 'loadDeviceToken').mockResolvedValue({ token: 'device', stored: true })
    vi.spyOn(accountClient, 'getSession').mockImplementation(async () => {
      vaultKeys.clear()
      return 'late-session'
    })

    await expect(establishSessionFromKeyHash('acct-1', 'key-hash')).rejects.toThrow('locked')

    expect(endSession).toHaveBeenCalledExactlyOnceWith('acct-1', 'late-session')
    expect(getApiAuthToken()).toBe('')
  })
})
