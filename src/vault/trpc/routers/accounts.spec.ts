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
})
