import { TRPCError } from '@trpc/server'
import { hashString } from '../../api/util'
import { accountsRouter } from './accounts'


function createContext(overrides?: { authToken?: string, checkSessionSuccess?: boolean }) {
  const checkSessionSuccess = overrides?.checkSessionSuccess ?? true
  const vault = {
    getNewAccountId: vi.fn(async () => 'acct-1'),
    createAccount: vi.fn(async () => true),
    checkSession: vi.fn(async () => ({ success: checkSessionSuccess })),
    updateAccountData: vi.fn(async () => undefined),
    getAccountSalt: vi.fn(async () => 'salt-1'),
    getAccount: vi.fn(async () => ({ metadata: { theme: 'light' } })),
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

  it('rejects invalid metadata schema for updateMetadata', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.updateMetadata({
      account: 'acct-1',
      metadata: 'invalid-metadata' as unknown as Record<string, unknown>,
    })).rejects.toBeDefined()

    expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
  })

  it('blocks unauthorized metadata access when auth token is missing', async () => {
    const ctx = createContext({ authToken: '' })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.getMetadata({ account: 'acct-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>)
  })

  it('blocks unauthorized metadata access when session validation fails', async () => {
    const ctx = createContext({ checkSessionSuccess: false })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.getMetadata({ account: 'acct-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>)
  })

  it('rotates session on login without mutating account metadata payloads', async () => {
    const ctx = createContext()
    const caller = accountsRouter.createCaller(ctx as any)

    const result = await caller.login({ account: 'acct-1', authToken: 'secret-password' })

    expect(result.success).toBe(true)
    expect(result.session).toBeTypeOf('string')
    expect(result.session.length).toBeGreaterThan(0)
    expect(ctx.vault.checkSession).toHaveBeenCalledWith({
      account: 'acct-1',
      session: hashString('secret-password'),
      isLogin: true,
    })
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      session: result.session,
      sessions: [
        {
          token: result.session,
          expiry: expect.any(Number),
        },
      ],
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
    const ctx = createContext({ checkSessionSuccess: false })
    const caller = accountsRouter.createCaller(ctx as any)

    await expect(caller.updateKeyring({
      account: 'acct-1',
      keyring: 'some-keyring',
    })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })
})
