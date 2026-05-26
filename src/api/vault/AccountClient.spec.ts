import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createAccount,
  getSecurityParams,
  getSession,
  recordPrayerCompletion,
} from './AccountClient'
import { DEFAULT_CRYPTO_ITERATIONS } from './util'
import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'

vi.mock('../trpcClient', () => ({
  trpcClient: {
    accounts: {
      createAccount: { mutate: vi.fn() },
      getSecurityParams: { query: vi.fn() },
      login: { mutate: vi.fn() },
      recordPrayerCompletion: { mutate: vi.fn() },
    },
  },
}))

vi.mock('../util', () => ({
  getAccountId: vi.fn(() => 'acc-1'),
}))

describe('AccountClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates accounts with expected iterations', async () => {
    vi.mocked(trpcClient.accounts.createAccount.mutate).mockResolvedValue({ account: 'acc-1' })

    await createAccount({ salt: 'salt', authToken: 'token' })

    expect(trpcClient.accounts.createAccount.mutate).toHaveBeenCalledWith({
      salt: 'salt',
      authToken: 'token',
      iterations: DEFAULT_CRYPTO_ITERATIONS,
    })
  })

  it('gets security params for the active account', async () => {
    vi.mocked(trpcClient.accounts.getSecurityParams.query).mockResolvedValue({
      salt: 'salt-2',
      iterations: 222,
      success: true,
    })

    await expect(getSecurityParams()).resolves.toEqual({
      salt: 'salt-2',
      iterations: 222,
    })
    expect(getAccountId).toHaveBeenCalled()
  })

  it('returns a session token on login', async () => {
    vi.mocked(trpcClient.accounts.login.mutate).mockResolvedValue({
      success: true,
      session: 'sess-1',
    })

    await expect(getSession('auth-1')).resolves.toBe('sess-1')
  })

  it('throws when login response is missing a session', async () => {
    vi.mocked(trpcClient.accounts.login.mutate).mockResolvedValue({
      success: true,
    } as { success: boolean; session: string })

    await expect(getSession('auth-2')).rejects.toThrow('missing session')
  })

  it('records prayer completion for the active account', async () => {
    vi.mocked(trpcClient.accounts.recordPrayerCompletion.mutate).mockResolvedValue({
      success: true,
    })

    await recordPrayerCompletion(123)

    expect(trpcClient.accounts.recordPrayerCompletion.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      completedAt: 123,
    })
  })
})
