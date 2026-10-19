import {
  createAccount,
  getSecurityParams,
  getSession,
  getKeyring,
  updateKeyring,
  changePassword,
} from './AccountClient'
import { DEFAULT_CRYPTO_ITERATIONS, LEGACY_CRYPTO_ITERATIONS } from './util'
import { getVaultTrpcClient } from './vaultTrpcClient'

const mockTrpcClient = {
  accounts: {
    createAccount: { mutate: vi.fn() },
    getSecurityParams: { query: vi.fn() },
    login: { mutate: vi.fn() },
    getKeyring: { query: vi.fn() },
    updateKeyring: { mutate: vi.fn() },
    changePassword: { mutate: vi.fn() },
  },
}

vi.mock('./vaultTrpcClient', () => ({
  getVaultTrpcClient: vi.fn(() => mockTrpcClient),
}))

const ARGON2ID = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }

describe('AccountClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates accounts with expected iterations', async () => {
    vi.mocked(getVaultTrpcClient().accounts.createAccount.mutate).mockResolvedValue({ account: 'acc-1' })

    await createAccount({ salt: 'salt', authToken: 'token' })

    expect(getVaultTrpcClient().accounts.createAccount.mutate).toHaveBeenCalledWith({
      salt: 'salt',
      authToken: 'token',
      iterations: DEFAULT_CRYPTO_ITERATIONS,
    })
  })

  it('gets security params for the active account', async () => {
    vi.mocked(getVaultTrpcClient().accounts.getSecurityParams.query).mockResolvedValue({
      salt: 'salt-2',
      iterations: 222,
      dataVersion: 1,
      success: true,
    })

    await expect(getSecurityParams('acc-1')).resolves.toEqual({
      salt: 'salt-2',
      iterations: 222,
      dataVersion: 1,
    })
  })

  it('creates Argon2id accounts with their keyring and without iterations', async () => {
    vi.mocked(getVaultTrpcClient().accounts.createAccount.mutate).mockResolvedValue({ account: 'acc-1' })

    await createAccount({ salt: 'salt', authToken: 'token', saltVersion: 1, kdf: ARGON2ID, keyring: 'keyring', randomDataKeys: true })

    expect(getVaultTrpcClient().accounts.createAccount.mutate).toHaveBeenCalledWith({
      salt: 'salt',
      authToken: 'token',
      saltVersion: 1,
      kdf: ARGON2ID,
      keyring: 'keyring',
      randomDataKeys: true,
    })
  })

  it('returns the Argon2id parameters of an account, without a fallback iteration count', async () => {
    vi.mocked(getVaultTrpcClient().accounts.getSecurityParams.query).mockResolvedValue({
      salt: 'salt-4',
      saltVersion: 1,
      kdf: ARGON2ID,
      dataVersion: 2,
      success: true,
    })

    await expect(getSecurityParams('acc-1')).resolves.toEqual({
      salt: 'salt-4',
      iterations: undefined,
      saltVersion: 1,
      kdf: ARGON2ID,
      dataVersion: 2,
    })
  })

  it('falls back to LEGACY_CRYPTO_ITERATIONS when iterations is missing in server response', async () => {
    vi.mocked(getVaultTrpcClient().accounts.getSecurityParams.query).mockResolvedValue({
      salt: 'salt-3',
      dataVersion: 0,
      success: true,
    })

    await expect(getSecurityParams('acc-1')).resolves.toEqual({
      salt: 'salt-3',
      iterations: LEGACY_CRYPTO_ITERATIONS,
      dataVersion: 0,
    })
  })

  it('returns a session token on login', async () => {
    vi.mocked(getVaultTrpcClient().accounts.login.mutate).mockResolvedValue({
      success: true,
      session: 'sess-1',
    })

    await expect(getSession('acc-1', 'auth-1')).resolves.toBe('sess-1')
  })

  it('throws when login response is missing a session', async () => {
    vi.mocked(getVaultTrpcClient().accounts.login.mutate).mockResolvedValue({
      success: true,
    } as { success: boolean; session: string })

    await expect(getSession('acc-1', 'auth-2')).rejects.toThrow('missing session')
  })

  it('fetches keyring for the active account', async () => {
    vi.mocked(getVaultTrpcClient().accounts.getKeyring.query).mockResolvedValue({
      success: true,
      keyring: 'encrypted-keyring-data',
    })

    const keyring = await getKeyring('acc-1')
    expect(keyring).toBe('encrypted-keyring-data')
    expect(getVaultTrpcClient().accounts.getKeyring.query).toHaveBeenCalledWith({
      account: 'acc-1',
    })
  })

  it('updates keyring for the active account', async () => {
    vi.mocked(getVaultTrpcClient().accounts.updateKeyring.mutate).mockResolvedValue({
      success: true,
    })

    await updateKeyring('acc-1', 'new-keyring-data')
    expect(getVaultTrpcClient().accounts.updateKeyring.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      keyring: 'new-keyring-data',
    })
  })

  it('passes expectedKeyringVersion and keyringVersion when updating keyring', async () => {
    vi.mocked(getVaultTrpcClient().accounts.updateKeyring.mutate).mockResolvedValue({
      success: true,
    })

    await updateKeyring('acc-1', 'new-keyring-data', 1, 2)
    expect(getVaultTrpcClient().accounts.updateKeyring.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      keyring: 'new-keyring-data',
      expectedKeyringVersion: 1,
      keyringVersion: 2,
    })
  })

  it('calls changePassword with expected params', async () => {
    vi.mocked(getVaultTrpcClient().accounts.changePassword.mutate).mockResolvedValue({
      success: true,
    })

    await changePassword({
      account: 'acc-1',
      currentAuthToken: 'cur-token',
      newAuthToken: 'new-token',
      newSalt: 'new-salt',
      newKdf: ARGON2ID,
      newKeyring: 'new-keyring',
    })

    expect(getVaultTrpcClient().accounts.changePassword.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      currentAuthToken: 'cur-token',
      newAuthToken: 'new-token',
      newSalt: 'new-salt',
      newKdf: ARGON2ID,
      newKeyring: 'new-keyring',
    })
  })
})
