import { accountsRouter } from './accounts'
import { AuthenticationError } from '../../errors'
import { fakeSalt, hashString } from '../../util'
import { hashSessionToken, SESSION_EXPIRY_MS } from '../../sessions'
import { MAX_FAILED_LOGINS } from '../../loginThrottle'
import { VersionConflictError } from '@vault/shared'

const ARGON2ID = { algorithm: 'argon2id' as const, memoryKiB: 65536, passes: 3, parallelism: 1 }
const NEW_ACCOUNT = {
  salt: 'salt',
  authToken: 'auth',
  saltVersion: 1,
  kdf: ARGON2ID,
  keyring: 'encrypted-keyring',
  randomDataKeys: true as const,
}

/** What the client sends as proof of the master key, and the hash the server stores of it */
const CURRENT_AUTH_TOKEN = 'current-auth-token'
const SESSION_TOKEN = 'session-token'
const SESSION_EXPIRY = Date.now() + SESSION_EXPIRY_MS

/** A stored account record with an active session for SESSION_TOKEN */
function storedAccount(fields: Record<string, unknown> = {}) {
  return {
    account: 'acct-1',
    ...fields,
    sessions: [{ token: hashSessionToken(SESSION_TOKEN), expiry: SESSION_EXPIRY }],
  }
}

function createContext(overrides?: { authToken?: string, sessionValid?: boolean }) {
  const sessionValid = overrides?.sessionValid ?? true
  const vault = {
    getNewAccountId: vi.fn(async () => 'acct-1'),
    createAccount: vi.fn(async () => true),
    updateAccountData: vi.fn(async () => undefined),
    getAccountSalt: vi.fn(async () => 'salt-1'),
    getAccountRecord: vi.fn(async () => (
      sessionValid
        ? storedAccount({ metadata: { theme: 'light' }, authToken: hashString(CURRENT_AUTH_TOKEN) })
        : undefined
    )),
    extendSession: vi.fn(async () => undefined),
    addSession: vi.fn(async () => undefined),
    recordFailedLogin: vi.fn(async () => undefined),
  }

  return {
    authToken: overrides?.authToken ?? SESSION_TOKEN,
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

    const result = await caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN })

    expect(result.success).toBe(true)
    expect(result.session).toBeTypeOf('string')
    expect(result.session.length).toBeGreaterThan(0)
    expect(ctx.vault.getAccountRecord).toHaveBeenCalledWith({ account: 'acct-1' })
    expect(ctx.vault.addSession).toHaveBeenCalledWith({
      account: 'acct-1',
      session: result.session,
      expiry: expect.any(Number),
    })
    expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
  })

  it('rejects a login with the wrong credentials as UNAUTHORIZED', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: 'wrong' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(ctx.vault.addSession).not.toHaveBeenCalled()
    expect(ctx.vault.recordFailedLogin).toHaveBeenCalledWith({ account: 'acct-1' })
  })

  it('rejects a login to an account that does not exist as UNAUTHORIZED', async () => {
    const ctx = createContext({ sessionValid: false })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(ctx.vault.addSession).not.toHaveBeenCalled()
  })

  it('still reports a wrong password as UNAUTHORIZED when counting the failure fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = createContext()
    ctx.vault.recordFailedLogin.mockRejectedValueOnce(new Error('DynamoDB timeout'))
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: 'wrong' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('refuses logins to an account with too many failed logins as TOO_MANY_REQUESTS', async () => {
    const ctx = createContext()
    ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
      authToken: hashString(CURRENT_AUTH_TOKEN),
      failedLogins: MAX_FAILED_LOGINS,
      failedLoginsSince: Date.now(),
    }) as any)
    const caller = accountsRouter.createCaller(ctx as any)

    // Even with the right password
    await expect(caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
    expect(ctx.vault.recordFailedLogin).not.toHaveBeenCalled()
    expect(ctx.vault.addSession).not.toHaveBeenCalled()
  })


  it('does not report a database failure during login as UNAUTHORIZED', async () => {
    const ctx = createContext()
    ctx.vault.getAccountRecord.mockRejectedValueOnce(new Error('DynamoDB timeout'))
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })
  })

  it('retries account creation with a new ID when another sign-up took the first one', async () => {
    const ctx = createContext({ authToken: '' })
    ctx.vault.getNewAccountId
      .mockResolvedValueOnce('acct-1')
      .mockResolvedValueOnce('acct-2')
    ctx.vault.createAccount.mockResolvedValueOnce(false)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.createAccount(NEW_ACCOUNT))
      .resolves.toEqual({ account: 'acct-2' })
    expect(ctx.vault.createAccount).toHaveBeenCalledTimes(2)
  })

  it('stores the Argon2id parameters and keyring of a new account', async () => {
    const ctx = createContext({ authToken: '' })
    const caller = accountsRouter.createCaller(ctx as any)

    await caller.createAccount(NEW_ACCOUNT)

    expect(ctx.vault.createAccount).toHaveBeenCalledWith({
      account: 'acct-1',
      authToken: hashString('auth'),
      salt: 'salt',
      saltVersion: 1,
      kdf: ARGON2ID,
      keyring: 'encrypted-keyring',
      randomDataKeys: true,
    })
  })

  it.each([
    ['PBKDF2 credentials', { salt: 'salt', authToken: 'auth', iterations: 600000, keyring: 'encrypted-keyring', randomDataKeys: true }],
    ['no keyring', { ...NEW_ACCOUNT, keyring: undefined }],
    ['a keyring that may hold a password-derived key', { ...NEW_ACCOUNT, randomDataKeys: undefined }],
  ])('rejects a new account with %s', async (_case, body) => {
    const ctx = createContext({ authToken: '' })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.createAccount(body as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(ctx.vault.createAccount).not.toHaveBeenCalled()
  })

  it('allows fetching keyring when authorized', async () => {
    const ctx = createContext()
    const expectedKeyring = 'encrypted-keyring-data'
    ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
      account: 'acct-1',
      keyring: expectedKeyring,
      salt: 'salt-1',
      iterations: 100000,
    }) as any)
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.getKeyring({ account: 'acct-1' })
    expect(result).toEqual({ success: true, keyring: expectedKeyring, randomDataKeys: false })
    expect(ctx.vault.getAccountRecord).toHaveBeenCalledWith({ account: 'acct-1' })
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
      currentAuthToken: CURRENT_AUTH_TOKEN,
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
      currentAuthToken: CURRENT_AUTH_TOKEN,
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
      currentAuthToken: CURRENT_AUTH_TOKEN,
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

  it('rejects a keyring update without proof of the current password', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.updateKeyring({
      account: 'acct-1',
      currentAuthToken: 'wrong-auth-token',
      keyring: 'garbage-keyring',
      keyringVersion: 99,
    })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Incorrect current password',
    })
    await expect(caller.updateKeyring({
      account: 'acct-1',
      keyring: 'garbage-keyring',
    } as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
  })

  it('throws CONFLICT when updateKeyring hits a keyringVersion conflict', async () => {
    const ctx = createContext()
    ctx.vault.updateAccountData.mockRejectedValueOnce(new VersionConflictError('keyringVersion has changed'))
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.updateKeyring({
      account: 'acct-1',
      currentAuthToken: CURRENT_AUTH_TOKEN,
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

    ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
      account: 'acct-1',
      authToken: serverStoredAuthToken,
      salt: 'salt-1',
      iterations: 100000,
    }) as any)
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.changePassword({
      account: 'acct-1',
      currentAuthToken: clientCurrentAuthToken,
      newAuthToken: clientNewAuthToken,
      newSalt: 'new-salt',
      newKdf: ARGON2ID,
      newKeyring: 'new-keyring',
    })

    expect(result).toEqual({ success: true })
    // A PBKDF2 account's stored iterations are left alone: clients ignore them once `kdf` is set
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      authToken: hashString(clientNewAuthToken),
      salt: 'new-salt',
      kdf: ARGON2ID,
      keyring: 'new-keyring',
      sessions: [{ token: hashSessionToken(SESSION_TOKEN), expiry: SESSION_EXPIRY }],
    })
  })

  it('rejects a new PBKDF2 password, which would leave the account\'s Argon2id parameters stale', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.changePassword({
      account: 'acct-1',
      currentAuthToken: hashString('current-password'),
      newAuthToken: hashString('new-password'),
      newSalt: 'new-salt',
      newIterations: 600000,
      newKeyring: 'new-keyring',
    } as any)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
  })

  it('rejects password change if currentAuthToken is incorrect', async () => {
    const ctx = createContext()
    const clientCurrentAuthToken = hashString('correct-password')
    const serverStoredAuthToken = hashString(clientCurrentAuthToken)

    ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
      account: 'acct-1',
      authToken: serverStoredAuthToken,
    }) as any)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.changePassword({
      account: 'acct-1',
      currentAuthToken: hashString('incorrect-password-hash'),
      newAuthToken: hashString('new-password-hash'),
      newSalt: 'new-salt',
      newKdf: ARGON2ID,
      newKeyring: 'new-keyring',
    })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Incorrect current password',
    })
  })

  it('throws CONFLICT when changePassword hits a keyringVersion conflict', async () => {
    const ctx = createContext()
    const clientCurrentAuthToken = hashString('correct-password')
    const serverStoredAuthToken = hashString(clientCurrentAuthToken)

    ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
      account: 'acct-1',
      authToken: serverStoredAuthToken,
    }) as any)

    ctx.vault.updateAccountData.mockRejectedValueOnce(new VersionConflictError('keyringVersion has changed'))
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.changePassword({
      account: 'acct-1',
      currentAuthToken: clientCurrentAuthToken,
      newAuthToken: hashString('new-password'),
      newSalt: 'new-salt',
      newKdf: ARGON2ID,
      newKeyring: 'new-keyring',
      expectedKeyringVersion: 1,
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Concurrent credential update detected: keyringVersion conflict',
    })
  })

  describe('single account read efficiency in protectedProcedure', () => {
    it('reads the account exactly once for getKeyring', async () => {
      const ctx = createContext()
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
        account: 'acct-1',
        keyring: 'encrypted-keyring',
      }) as any)
      const caller = accountsRouter.createCaller(ctx as any)

      const result = await caller.getKeyring({ account: 'acct-1' })

      expect(result).toEqual({ success: true, keyring: 'encrypted-keyring', randomDataKeys: false })
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledTimes(1)
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledWith({ account: 'acct-1' })
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

    it('reports an unknown account as NOT_FOUND without made-up parameters configured', async () => {
      const ctx = createContext({ authToken: '' })
      const getSecurityParams = vi.fn(async () => {
        throw new AuthenticationError('Could not find account acct-1')
      })
      const caller = accountsRouter.createCaller({ ...ctx, vault: { ...ctx.vault, getSecurityParams } } as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('answers an unknown account with stable made-up parameters when configured', async () => {
      const ctx = createContext({ authToken: '' })
      const getSecurityParams = vi.fn(async () => {
        throw new AuthenticationError('Could not find account acct-1')
      })
      const caller = accountsRouter.createCaller({
        ...ctx,
        vault: { ...ctx.vault, getSecurityParams },
        unknownAccountParams: { secret: 'server-secret', iterations: 600000, saltVersion: 1 },
        dataVersionPolicy: { current: 3, findBlockers: vi.fn() },
      } as any)

      const params = await caller.getSecurityParams({ account: 'acct-1' })
      expect(params).toEqual({
        success: true,
        salt: fakeSalt('acct-1', 'server-secret'),
        iterations: 600000,
        saltVersion: 1,
        dataVersion: 3,
      })
      await expect(caller.getSecurityParams({ account: 'acct-1' })).resolves.toEqual(params)
    })

    it('answers unknown accounts with the same fields as a real Argon2id account', async () => {
      const ctx = createContext({ authToken: '' })
      const realParams = { salt: 'salt-1', saltVersion: 1, kdf: ARGON2ID, dataVersion: 3 }
      const getSecurityParams = vi.fn(async ({ account }: { account: string }) => {
        if (account === 'real') return realParams
        throw new AuthenticationError(`Could not find account ${account}`)
      })
      const caller = accountsRouter.createCaller({
        ...ctx,
        vault: { ...ctx.vault, getSecurityParams },
        unknownAccountParams: { secret: 'server-secret', saltVersion: 1, kdf: ARGON2ID },
        dataVersionPolicy: { current: 3, findBlockers: vi.fn() },
      } as any)

      const definedKeys = (params: object) => Object.entries(params)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .sort()
      const real = await caller.getSecurityParams({ account: 'real' })
      const unknown = await caller.getSecurityParams({ account: 'unknown' })

      expect(unknown.kdf).toEqual(ARGON2ID)
      expect(definedKeys(unknown)).toEqual(definedKeys(real))
    })

    it('does not hide a database failure behind made-up parameters', async () => {
      const ctx = createContext({ authToken: '' })
      const getSecurityParams = vi.fn(async () => {
        throw new Error('DynamoDB timeout')
      })
      const caller = accountsRouter.createCaller({
        ...ctx,
        vault: { ...ctx.vault, getSecurityParams },
        unknownAccountParams: { secret: 'server-secret', iterations: 600000 },
      } as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
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
      const getAccountRecord = vi.fn(async () => storedAccount({ dataVersion: 2 }))
      const caller = accountsRouter.createCaller({
        ...ctx,
        vault: { ...ctx.vault, getAccountRecord },
        dataVersionPolicy: { current: 2, findBlockers },
      } as any)

      await expect(caller.raiseDataVersion({ account: 'acct-1' }))
        .resolves.toEqual({ success: true, dataVersion: 2, blockers: [] })
      expect(findBlockers).not.toHaveBeenCalled()
    })
  })
})
