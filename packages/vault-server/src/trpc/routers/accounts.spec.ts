import { accountsRouter } from './accounts'
import { fakeSalt, hashString } from '../../util'
import { hashSessionToken, SESSION_EXPIRY_MS } from '../../sessions'
import type { LoginAttemptReservation } from '../../loginThrottle'
import { signupReservation } from '../../signupThrottle'
import {
  DEVICE_TOKEN_LENGTH,
  isValidNewAccountId,
  MAX_AUTH_TOKEN_LENGTH,
  MAX_KEYRING_LENGTH,
  MAX_SALT_LENGTH,
  TOO_MANY_REQUESTS_MESSAGE,
  VersionConflictError,
} from '@vault/shared'

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
const DEVICE_TOKEN = 'd'.repeat(DEVICE_TOKEN_LENGTH)
const RESERVATION: LoginAttemptReservation = { since: Date.now() }
/** What reserving an attempt gives for a locked ID */
const LOCKED = undefined
const SIGNUP_THROTTLE = { secret: 'signup-secret' }

/** A stored account record with an active session for SESSION_TOKEN */
function storedAccount(fields: Record<string, unknown> = {}) {
  return {
    account: 'acct-1',
    ...fields,
    sessions: [{ token: hashSessionToken(SESSION_TOKEN), expiry: SESSION_EXPIRY }],
  }
}

function createContext(overrides?: {
  authToken?: string,
  sessionValid?: boolean,
  signupThrottle?: { secret: string },
  clientAddress?: string,
}) {
  const sessionValid = overrides?.sessionValid ?? true
  const vault = {
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
    reserveLoginAttempt: vi.fn(async (): Promise<LoginAttemptReservation | undefined> => RESERVATION),
    releaseLoginAttempt: vi.fn(async () => undefined),
    removeLoginDevice: vi.fn(async () => undefined),
    reserveSignup: vi.fn(async () => true),
  }

  return {
    authToken: overrides?.authToken ?? SESSION_TOKEN,
    vault,
    signupThrottle: overrides?.signupThrottle,
    clientAddress: overrides?.clientAddress,
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

  it('counts the attempt before checking the password, and uncounts it when the password is right', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN })

    expect(ctx.vault.reserveLoginAttempt).toHaveBeenCalledWith({ account: 'acct-1' })
    expect(ctx.vault.releaseLoginAttempt).toHaveBeenCalledWith({ account: 'acct-1', ...RESERVATION })
    expect(ctx.vault.releaseLoginAttempt.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.vault.addSession.mock.invocationCallOrder[0])
  })

  it('still logs in when uncounting the attempt fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = createContext()
    ctx.vault.releaseLoginAttempt.mockRejectedValueOnce(new Error('DynamoDB timeout'))
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN }))
      .resolves.toMatchObject({ success: true })
  })

  it('rejects a login with the wrong credentials as UNAUTHORIZED', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: 'wrong' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(ctx.vault.addSession).not.toHaveBeenCalled()
    expect(ctx.vault.reserveLoginAttempt).toHaveBeenCalledWith({ account: 'acct-1' })
    expect(ctx.vault.releaseLoginAttempt).not.toHaveBeenCalled()
  })

  it('rejects a login to an account that does not exist as UNAUTHORIZED', async () => {
    const ctx = createContext({ sessionValid: false })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
    expect(ctx.vault.addSession).not.toHaveBeenCalled()
  })

  it('refuses logins to an account with too many failed logins as TOO_MANY_REQUESTS', async () => {
    const ctx = createContext()
    ctx.vault.reserveLoginAttempt.mockResolvedValueOnce(LOCKED)
    const caller = accountsRouter.createCaller(ctx as any)

    // Even with the right password
    await expect(caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
    expect(ctx.vault.releaseLoginAttempt).not.toHaveBeenCalled()
    expect(ctx.vault.addSession).not.toHaveBeenCalled()
  })

  it('locks an ID with no account just as it locks a real one', async () => {
    const ctx = createContext({ sessionValid: false })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: 'wrong' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(ctx.vault.reserveLoginAttempt).toHaveBeenCalledWith({ account: 'acct-1' })

    ctx.vault.reserveLoginAttempt.mockResolvedValueOnce(LOCKED)
    await expect(caller.login({ account: 'acct-1', authToken: 'wrong' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: TOO_MANY_REQUESTS_MESSAGE,
    })
  })

  it('registers the device a login comes from', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN, deviceToken: DEVICE_TOKEN })

    expect(ctx.vault.addSession).toHaveBeenCalledWith({
      account: 'acct-1',
      session: result.session,
      expiry: expect.any(Number),
      device: hashString(DEVICE_TOKEN),
    })
  })

  it('rejects a device token of the wrong length', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN, deviceToken: 'short' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(ctx.vault.addSession).not.toHaveBeenCalled()
  })

  it('lets a login device with the right password through a lock', async () => {
    const ctx = createContext()
    ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
      authToken: hashString(CURRENT_AUTH_TOKEN),
      loginDevices: [hashString(DEVICE_TOKEN)],
    }) as any)
    ctx.vault.reserveLoginAttempt.mockResolvedValueOnce(LOCKED)
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.login({ account: 'acct-1', authToken: CURRENT_AUTH_TOKEN, deviceToken: DEVICE_TOKEN })

    expect(result.success).toBe(true)
    expect(ctx.vault.releaseLoginAttempt).not.toHaveBeenCalled()
  })

  it('forgets a login device that comes with the wrong password', async () => {
    const ctx = createContext()
    ctx.vault.getAccountRecord.mockResolvedValue(storedAccount({
      authToken: hashString(CURRENT_AUTH_TOKEN),
      loginDevices: [hashString(DEVICE_TOKEN)],
    }) as any)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: 'wrong', deviceToken: DEVICE_TOKEN }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(ctx.vault.removeLoginDevice).toHaveBeenCalledWith({ account: 'acct-1', device: hashString(DEVICE_TOKEN) })

    // Also while locked
    vi.clearAllMocks()
    ctx.vault.reserveLoginAttempt.mockResolvedValueOnce(LOCKED)
    await expect(caller.login({ account: 'acct-1', authToken: 'wrong', deviceToken: DEVICE_TOKEN }))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' })
    expect(ctx.vault.removeLoginDevice).toHaveBeenCalledWith({ account: 'acct-1', device: hashString(DEVICE_TOKEN) })
  })

  it('does not forget anything for an unknown device with the wrong password', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.login({ account: 'acct-1', authToken: 'wrong', deviceToken: DEVICE_TOKEN }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(ctx.vault.removeLoginDevice).not.toHaveBeenCalled()
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
    ctx.vault.createAccount.mockResolvedValueOnce(false)
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.createAccount(NEW_ACCOUNT)

    const attempted = ctx.vault.createAccount.mock.calls.map(([data]: any[]) => data.account)
    expect(attempted).toHaveLength(2)
    expect(attempted[0]).not.toBe(attempted[1])
    expect(result).toEqual({ account: attempted[1] })
  })

  it('gives up creating an account after repeated ID collisions', async () => {
    const ctx = createContext({ authToken: '' })
    ctx.vault.createAccount.mockResolvedValue(false)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.createAccount(NEW_ACCOUNT)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
    expect(ctx.vault.createAccount).toHaveBeenCalledTimes(10)
  })

  it('stores the Argon2id parameters and keyring of a new account', async () => {
    const ctx = createContext({ authToken: '' })
    const caller = accountsRouter.createCaller(ctx as any)

    const { account } = await caller.createAccount(NEW_ACCOUNT)

    expect(isValidNewAccountId(account)).toBe(true)
    expect(ctx.vault.createAccount).toHaveBeenCalledWith({
      account,
      authToken: hashString('auth'),
      salt: 'salt',
      saltVersion: 1,
      kdf: ARGON2ID,
      keyring: 'encrypted-keyring',
      randomDataKeys: true,
    })
  })

  it('counts a sign-up against the client network before creating the account', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const ctx = createContext({ authToken: '', signupThrottle: SIGNUP_THROTTLE, clientAddress: '2001:db8::1' })
    const caller = accountsRouter.createCaller(ctx as any)

    await caller.createAccount(NEW_ACCOUNT)

    expect(ctx.vault.reserveSignup).toHaveBeenCalledWith(signupReservation(SIGNUP_THROTTLE, '2001:db8::1', now))
    expect(ctx.vault.reserveSignup.mock.invocationCallOrder[0])
      .toBeLessThan(ctx.vault.createAccount.mock.invocationCallOrder[0])
  })

  it('refuses a sign-up as TOO_MANY_REQUESTS once the network has used up its sign-ups', async () => {
    const ctx = createContext({ authToken: '', signupThrottle: SIGNUP_THROTTLE, clientAddress: '192.0.2.1' })
    ctx.vault.reserveSignup.mockResolvedValueOnce(false)
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.createAccount(NEW_ACCOUNT)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: TOO_MANY_REQUESTS_MESSAGE,
    })
    expect(ctx.vault.createAccount).not.toHaveBeenCalled()
  })

  it('creates accounts without counting them when sign-ups are not limited', async () => {
    const ctx = createContext({ authToken: '', clientAddress: '192.0.2.1' })
    const caller = accountsRouter.createCaller(ctx as any)

    await caller.createAccount(NEW_ACCOUNT)

    expect(ctx.vault.reserveSignup).not.toHaveBeenCalled()
    expect(ctx.vault.createAccount).toHaveBeenCalled()
  })

  it('creates an account without counting it when the client address is not an IP address', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = createContext({ authToken: '', signupThrottle: SIGNUP_THROTTLE })
    const caller = accountsRouter.createCaller(ctx as any)

    await caller.createAccount(NEW_ACCOUNT)

    expect(ctx.vault.reserveSignup).not.toHaveBeenCalled()
    expect(ctx.vault.createAccount).toHaveBeenCalled()
  })

  it("records the new keyring's active version, so the first rotation's version check matches it", async () => {
    const ctx = createContext({ authToken: '' })
    const caller = accountsRouter.createCaller(ctx as any)

    await caller.createAccount({ ...NEW_ACCOUNT, keyringVersion: 2 })

    expect(ctx.vault.createAccount).toHaveBeenCalledWith(expect.objectContaining({ keyringVersion: 2 }))
  })

  it.each([
    ['PBKDF2 credentials', { salt: 'salt', authToken: 'auth', iterations: 600000, keyring: 'encrypted-keyring', randomDataKeys: true }],
    ['no keyring', { ...NEW_ACCOUNT, keyring: undefined }],
    ['a keyring that may hold a password-derived key', { ...NEW_ACCOUNT, randomDataKeys: undefined }],
    ['an oversized keyring', { ...NEW_ACCOUNT, keyring: 'k'.repeat(MAX_KEYRING_LENGTH + 1) }],
    ['an oversized salt', { ...NEW_ACCOUNT, salt: 's'.repeat(MAX_SALT_LENGTH + 1) }],
    ['an oversized auth token', { ...NEW_ACCOUNT, authToken: 'a'.repeat(MAX_AUTH_TOKEN_LENGTH + 1) }],
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
      loginDevices: [],
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
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({
        authToken: 'hash',
        salt: 'salt-1',
        iterations: 1000,
        saltVersion: 1,
        dataVersion: 1,
        keyring: 'encrypted-keyring',
      }) as any)
      const caller = accountsRouter.createCaller(ctx as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).resolves.toEqual({
        success: true,
        salt: 'salt-1',
        iterations: 1000,
        saltVersion: 1,
        dataVersion: 1,
      })
      expect(ctx.vault.getAccountRecord).toHaveBeenCalledWith({ account: 'acct-1' })
    })

    it('returns the Argon2id parameters of an account', async () => {
      const ctx = createContext({ authToken: '' })
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({ salt: 'salt-1', saltVersion: 1, kdf: ARGON2ID }) as any)
      const caller = accountsRouter.createCaller(ctx as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).resolves.toEqual({
        success: true,
        salt: 'salt-1',
        iterations: undefined,
        saltVersion: 1,
        kdf: ARGON2ID,
        dataVersion: 0,
      })
    })

    it('falls back to the account ID as the salt for accounts from before per-account salts', async () => {
      const ctx = createContext({ authToken: '' })
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({ iterations: 1000 }) as any)
      const caller = accountsRouter.createCaller(ctx as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).resolves.toMatchObject({
        salt: 'acct-1',
        iterations: 1000,
      })
    })

    it('reports an unknown account as NOT_FOUND without made-up parameters configured', async () => {
      const ctx = createContext({ authToken: '', sessionValid: false })
      const caller = accountsRouter.createCaller(ctx as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    })

    it('answers an unknown account with stable made-up parameters when configured', async () => {
      const ctx = createContext({ authToken: '', sessionValid: false })
      const caller = accountsRouter.createCaller({
        ...ctx,
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
      const realRecord = storedAccount({
        account: 'real',
        authToken: 'hash',
        salt: 'salt-1',
        saltVersion: 1,
        kdf: ARGON2ID,
        dataVersion: 3,
      })
      ctx.vault.getAccountRecord.mockImplementation((async ({ account }: { account: string }) => (
        account === 'real' ? realRecord : undefined
      )) as any)
      const caller = accountsRouter.createCaller({
        ...ctx,
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
      ctx.vault.getAccountRecord.mockRejectedValueOnce(new Error('DynamoDB timeout'))
      const caller = accountsRouter.createCaller({
        ...ctx,
        unknownAccountParams: { secret: 'server-secret', iterations: 600000 },
      } as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      })
    })

    it('reports accounts that never recorded a data version as version 0', async () => {
      const ctx = createContext({ authToken: '' })
      ctx.vault.getAccountRecord.mockResolvedValueOnce(storedAccount({ salt: 'salt-1' }) as any)
      const caller = accountsRouter.createCaller(ctx as any)

      await expect(caller.getSecurityParams({ account: 'acct-1' })).resolves.toMatchObject({ dataVersion: 0 })
    })

    it('raises the data version when the policy finds nothing left to migrate', async () => {
      const ctx = createContext()
      const raiseDataVersion = vi.fn(async () => undefined)
      const findBlockers = vi.fn(async () => ({ blockers: [] }))
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
      const findBlockers = vi.fn(async () => ({ blockers: ['unboundSnapshots'] }))
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
      const findBlockers = vi.fn(async () => ({ blockers: ['unboundSnapshots'] }))
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
