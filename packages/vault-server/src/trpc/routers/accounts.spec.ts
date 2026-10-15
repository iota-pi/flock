import { accountsRouter } from './accounts'
import { hashString } from '../../util'


function createContext(overrides?: { authToken?: string, sessionValid?: boolean }) {
  const sessionValid = overrides?.sessionValid ?? true
  const vault = {
    getNewAccountId: vi.fn(async () => 'acct-1'),
    createAccount: vi.fn(async () => true),
    updateAccountData: vi.fn(async () => undefined),
    getAccountSalt: vi.fn(async () => 'salt-1'),
    getAccount: vi.fn(async () => {
      if (!sessionValid) {
        throw new Error('Unauthorized')
      }
      return { metadata: { theme: 'light' } }
    }),
    extendSession: vi.fn(async () => undefined),
  }

  return {
    authToken: overrides?.authToken ?? 'session-token',
    vault,
  }
}

describe('accountsRouter security contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rotates session on login without mutating account metadata payloads', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.login({ account: 'acct-1', authToken: 'secret-password' })

    expect(result.success).toBe(true)
    expect(result.session).toBeTypeOf('string')
    expect(result.session.length).toBeGreaterThan(0)
    expect(ctx.vault.getAccount).toHaveBeenCalledWith({
      account: 'acct-1',
      session: hashString('secret-password'),
      isLogin: true,
    })
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      sessions: [
        {
          token: result.session,
          expiry: expect.any(Number),
        },
      ],
      lastAccess: expect.any(Number),
    })
    expect(ctx.vault.updateAccountData).not.toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.anything() }),
    )
  })

  it('allows fetching keyring when authorized', async () => {
    const ctx = createContext()
    const expectedKeyring = 'encrypted-keyring-data'
    ctx.vault.getAccount.mockResolvedValueOnce({
      account: 'acct-1',
      keyring: expectedKeyring,
      salt: 'salt-1',
      iterations: 100000,
    } as any)
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.getKeyring({ account: 'acct-1' })
    expect(result).toEqual({ success: true, keyring: expectedKeyring })
    expect(ctx.vault.getAccount).toHaveBeenCalledWith({
      account: 'acct-1',
      session: 'session-token',
    })
  })

  it('blocks unauthorized keyring access when auth token is missing', async () => {
    const ctx = createContext({ authToken: '' })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.getKeyring({ account: 'acct-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('allows updating keyring when authorized', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)
    const newKeyring = 'new-encrypted-keyring'

    const result = await caller.updateKeyring({
      account: 'acct-1',
      keyring: newKeyring,
    })

    expect(result).toEqual({ success: true })
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      keyring: newKeyring,
    })
  })

  it('blocks unauthorized keyring updates when session validation fails', async () => {
    const ctx = createContext({ sessionValid: false })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.updateKeyring({
      account: 'acct-1',
      keyring: 'some-keyring',
    })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('passes keyringVersion and expectedKeyringVersion to updateAccountData when provided', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)
    const newKeyring = 'new-encrypted-keyring'

    const result = await caller.updateKeyring({
      account: 'acct-1',
      keyring: newKeyring,
      keyringVersion: 2,
      expectedKeyringVersion: 1,
    })

    expect(result).toEqual({ success: true })
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      keyring: newKeyring,
      keyringVersion: 2,
      expectedKeyringVersion: 1,
    })
  })

  it('throws CONFLICT when updateKeyring experiences ConditionalCheckFailedException', async () => {
    const ctx = createContext()
    const error = new Error('ConditionalCheckFailedException: The conditional request failed')
    error.name = 'ConditionalCheckFailedException'
    ctx.vault.updateAccountData.mockRejectedValueOnce(error)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.updateKeyring({
      account: 'acct-1',
      keyring: 'some-keyring',
      expectedKeyringVersion: 1,
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Concurrent key rotation detected: keyringVersion conflict',
    })
  })

  it('allows changing password when authorized and credentials are correct', async () => {
    const ctx = createContext()
    const rawCurrentPassword = 'current-password'
    const rawNewPassword = 'new-password'

    const clientCurrentAuthToken = hashString(rawCurrentPassword)
    const clientNewAuthToken = hashString(rawNewPassword)

    const serverStoredAuthToken = hashString(clientCurrentAuthToken)

    ctx.vault.getAccount.mockResolvedValueOnce({
      account: 'acct-1',
      authToken: serverStoredAuthToken,
      sessions: [{ token: 'session-token', expiry: 12345 }],
      salt: 'salt-1',
      iterations: 100000,
    } as any)
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.changePassword({
      account: 'acct-1',
      currentAuthToken: clientCurrentAuthToken,
      newAuthToken: clientNewAuthToken,
      newSalt: 'new-salt',
      newIterations: 100000,
      newKeyring: 'new-keyring',
    })

    expect(result).toEqual({ success: true })
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      authToken: hashString(clientNewAuthToken),
      salt: 'new-salt',
      iterations: 100000,
      keyring: 'new-keyring',
      sessions: [{ token: 'session-token', expiry: 12345 }],
    })
  })

  it('rejects password change if currentAuthToken is incorrect', async () => {
    const ctx = createContext()
    const clientCurrentAuthToken = hashString('correct-password')
    const serverStoredAuthToken = hashString(clientCurrentAuthToken)

    ctx.vault.getAccount.mockResolvedValueOnce({
      account: 'acct-1',
      authToken: serverStoredAuthToken,
      sessions: [{ token: 'session-token', expiry: 12345 }],
    } as any)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.changePassword({
      account: 'acct-1',
      currentAuthToken: hashString('incorrect-password-hash'),
      newAuthToken: hashString('new-password-hash'),
      newSalt: 'new-salt',
      newIterations: 100000,
      newKeyring: 'new-keyring',
    })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Incorrect current password',
    })
  })

  it('throws CONFLICT when changePassword experiences ConditionalCheckFailedException', async () => {
    const ctx = createContext()
    const clientCurrentAuthToken = hashString('correct-password')
    const serverStoredAuthToken = hashString(clientCurrentAuthToken)

    ctx.vault.getAccount.mockResolvedValueOnce({
      account: 'acct-1',
      authToken: serverStoredAuthToken,
      sessions: [{ token: 'session-token', expiry: 12345 }],
    } as any)

    const error = new Error('ConditionalCheckFailedException: The conditional request failed')
    error.name = 'ConditionalCheckFailedException'
    ctx.vault.updateAccountData.mockRejectedValueOnce(error)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.changePassword({
      account: 'acct-1',
      currentAuthToken: clientCurrentAuthToken,
      newAuthToken: hashString('new-password'),
      newSalt: 'new-salt',
      newIterations: 100000,
      newKeyring: 'new-keyring',
      expectedKeyringVersion: 1,
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Concurrent credential update detected: keyringVersion conflict',
    })
  })

  describe('single getAccount round-trip efficiency in protectedProcedure', () => {
    it('calls getAccount exactly once for getKeyring', async () => {
      const ctx = createContext()
      ctx.vault.getAccount.mockResolvedValueOnce({
        account: 'acct-1',
        keyring: 'encrypted-keyring',
      } as any)
      const caller = accountsRouter.createCaller(ctx as any)

      const result = await caller.getKeyring({ account: 'acct-1' })

      expect(result).toEqual({ success: true, keyring: 'encrypted-keyring' })
      expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
      expect(ctx.vault.getAccount).toHaveBeenCalledWith({
        account: 'acct-1',
        session: 'session-token',
      })
    })
  })

  describe('data version', () => {
    it('returns the account data version with the security params, before login', async () => {
      const ctx = createContext({ authToken: '' })
      const getSecurityParams = vi.fn(async () => ({ salt: 'salt-1', iterations: 1000, saltVersion: 1, dataVersion: 1 }))
      const caller = accountsRouter.createCaller({ ...ctx, vault: { ...ctx.vault, getSecurityParams } } as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).resolves.toEqual({
        success: true,
        salt: 'salt-1',
        iterations: 1000,
        saltVersion: 1,
        dataVersion: 1,
      })
    })

    it('reports accounts that never recorded a data version as version 0', async () => {
      const ctx = createContext({ authToken: '' })
      const getSecurityParams = vi.fn(async () => ({ salt: 'salt-1' }))
      const caller = accountsRouter.createCaller({ ...ctx, vault: { ...ctx.vault, getSecurityParams } } as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).resolves.toMatchObject({ dataVersion: 0 })
    })

    it('raises the data version when the policy finds nothing left to migrate', async () => {
      const ctx = createContext()
      const raiseDataVersion = vi.fn(async () => undefined)
      const findBlockers = vi.fn(async () => [])
      const caller = accountsRouter.createCaller({
        ...ctx,
        vault: { ...ctx.vault, raiseDataVersion },
        dataVersionPolicy: { current: 2, findBlockers },
      } as any)

      await expect(caller.raiseDataVersion({ account: 'acct-1' }))
        .resolves.toEqual({ success: true, dataVersion: 2, blockers: [] })
      expect(raiseDataVersion).toHaveBeenCalledWith({ account: 'acct-1', dataVersion: 2 })
    })

    it('reports what is left to migrate instead of raising the data version', async () => {
      const ctx = createContext()
      const raiseDataVersion = vi.fn(async () => undefined)
      const findBlockers = vi.fn(async () => ['unboundSnapshots'])
      const caller = accountsRouter.createCaller({
        ...ctx,
        vault: { ...ctx.vault, raiseDataVersion },
        dataVersionPolicy: { current: 2, findBlockers },
      } as any)

      await expect(caller.raiseDataVersion({ account: 'acct-1' }))
        .resolves.toEqual({ success: true, dataVersion: 0, blockers: ['unboundSnapshots'] })
      expect(raiseDataVersion).not.toHaveBeenCalled()
    })

    it('does not check accounts already at the current data version', async () => {
      const ctx = createContext()
      const findBlockers = vi.fn(async () => ['unboundSnapshots'])
      const getAccount = vi.fn(async () => ({ dataVersion: 2 }))
      const caller = accountsRouter.createCaller({
        ...ctx,
        vault: { ...ctx.vault, getAccount },
        dataVersionPolicy: { current: 2, findBlockers },
      } as any)

      await expect(caller.raiseDataVersion({ account: 'acct-1' }))
        .resolves.toEqual({ success: true, dataVersion: 2, blockers: [] })
      expect(findBlockers).not.toHaveBeenCalled()
    })
  })
})
