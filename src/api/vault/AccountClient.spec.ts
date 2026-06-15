import {
  createAccount,
  getSecurityParams,
  getSession,
  recordPrayerCompletion,
  getKeyring,
  updateKeyring,
  changePassword,
} from './AccountClient'
import { DEFAULT_CRYPTO_ITERATIONS, LEGACY_CRYPTO_ITERATIONS } from './util'
import { getTrpcClient } from '../trpcClient'

const mockTrpcClient = {
  accounts: {
    createAccount: { mutate: vi.fn() },
    getSecurityParams: { query: vi.fn() },
    login: { mutate: vi.fn() },
    recordPrayerCompletion: { mutate: vi.fn() },
    getKeyring: { query: vi.fn() },
    updateKeyring: { mutate: vi.fn() },
    changePassword: { mutate: vi.fn() },
  },
}

vi.mock('../trpcClient', () => ({
  getTrpcClient: vi.fn(() => mockTrpcClient),
}))

describe('AccountClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates accounts with expected iterations', async () => {
    vi.mocked(getTrpcClient().accounts.createAccount.mutate).mockResolvedValue({ account: 'acc-1' })

    await createAccount({ salt: 'salt', authToken: 'token' })

    expect(getTrpcClient().accounts.createAccount.mutate).toHaveBeenCalledWith({
      salt: 'salt',
      authToken: 'token',
      iterations: DEFAULT_CRYPTO_ITERATIONS,
    })
  })

  it('gets security params for the active account', async () => {
    vi.mocked(getTrpcClient().accounts.getSecurityParams.query).mockResolvedValue({
      salt: 'salt-2',
      iterations: 222,
      success: true,
    })

    await expect(getSecurityParams('acc-1')).resolves.toEqual({
      salt: 'salt-2',
      iterations: 222,
    })
  })

  it('falls back to LEGACY_CRYPTO_ITERATIONS when iterations is missing in server response', async () => {
    vi.mocked(getTrpcClient().accounts.getSecurityParams.query).mockResolvedValue({
      salt: 'salt-3',
      success: true,
    })

    await expect(getSecurityParams('acc-1')).resolves.toEqual({
      salt: 'salt-3',
      iterations: LEGACY_CRYPTO_ITERATIONS,
    })
  })

  it('returns a session token on login', async () => {
    vi.mocked(getTrpcClient().accounts.login.mutate).mockResolvedValue({
      success: true,
      session: 'sess-1',
    })

    await expect(getSession('acc-1', 'auth-1')).resolves.toBe('sess-1')
  })

  it('throws when login response is missing a session', async () => {
    vi.mocked(getTrpcClient().accounts.login.mutate).mockResolvedValue({
      success: true,
    } as { success: boolean; session: string })

    await expect(getSession('acc-1', 'auth-2')).rejects.toThrow('missing session')
  })

  it('records prayer completion for the active account', async () => {
    vi.mocked(getTrpcClient().accounts.recordPrayerCompletion.mutate).mockResolvedValue({
      success: true,
    })

    await recordPrayerCompletion('acc-1', 123)

    expect(getTrpcClient().accounts.recordPrayerCompletion.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      completedAt: 123,
    })
  })

  it('fetches keyring for the active account', async () => {
    vi.mocked(getTrpcClient().accounts.getKeyring.query).mockResolvedValue({
      success: true,
      keyring: 'encrypted-keyring-data',
    })

    const keyring = await getKeyring('acc-1')
    expect(keyring).toBe('encrypted-keyring-data')
    expect(getTrpcClient().accounts.getKeyring.query).toHaveBeenCalledWith({
      account: 'acc-1',
    })
  })

  it('updates keyring for the active account', async () => {
    vi.mocked(getTrpcClient().accounts.updateKeyring.mutate).mockResolvedValue({
      success: true,
    })

    await updateKeyring('acc-1', 'new-keyring-data')
    expect(getTrpcClient().accounts.updateKeyring.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      keyring: 'new-keyring-data',
    })
  })

  it('calls changePassword with expected params', async () => {
    vi.mocked(getTrpcClient().accounts.changePassword.mutate).mockResolvedValue({
      success: true,
    })

    await changePassword({
      account: 'acc-1',
      currentAuthToken: 'cur-token',
      newAuthToken: 'new-token',
      newSalt: 'new-salt',
      newIterations: 100,
      newKeyring: 'new-keyring',
    })

    expect(getTrpcClient().accounts.changePassword.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      currentAuthToken: 'cur-token',
      newAuthToken: 'new-token',
      newSalt: 'new-salt',
      newIterations: 100,
      newKeyring: 'new-keyring',
    })
  })
})
