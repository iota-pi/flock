import { TRPCError } from '@trpc/server'
import {
  router,
  publicProcedure,
  protectedProcedure,
  createVaultContext,
  shouldRenewSession,
} from './trpc'
import { hashSessionToken, SESSION_EXPIRY_MS, SESSION_RENEWAL_THRESHOLD_MS } from '../sessions'
import type { VaultAccountWithAuth, VaultSessionRecord } from '../drivers/base'
import { AuthenticationError, ExpiredSessionError } from '../drivers/errors'

describe('shouldRenewSession', () => {
  const authToken = 'test-token-123'
  const now = 1_700_000_000_000

  it('returns false when session was renewed recently (> 29 days remaining)', () => {
    const accountData = {
      sessions: [
        {
          token: authToken,
          expiry: now + SESSION_EXPIRY_MS, // exactly 30 days remaining
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(false)
  })

  it('returns false when exactly at 29 days remaining', () => {
    const accountData = {
      sessions: [
        {
          token: authToken,
          expiry: now + SESSION_RENEWAL_THRESHOLD_MS, // exactly 29 days remaining
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(false)
  })

  it('returns true when session has aged past threshold (< 29 days remaining)', () => {
    const accountData = {
      sessions: [
        {
          token: authToken,
          expiry: now + SESSION_RENEWAL_THRESHOLD_MS - 1000, // 28.99 days remaining
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(true)
  })

  it('returns true when session is nearing expiry (e.g. 1 hour remaining)', () => {
    const accountData = {
      sessions: [
        {
          token: authToken,
          expiry: now + 3600_000,
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(true)
  })

  it('returns true when sessions array is missing or empty', () => {
    const accountDataWithoutSessions = {}
    expect(shouldRenewSession(accountDataWithoutSessions, authToken, now)).toBe(true)

    const accountDataWithEmptySessions = { sessions: [] as VaultSessionRecord[] }
    expect(shouldRenewSession(accountDataWithEmptySessions, authToken, now)).toBe(true)
  })

  it('returns true when session token does not match', () => {
    const accountData = {
      sessions: [
        {
          token: 'different-token',
          expiry: now + SESSION_EXPIRY_MS,
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(true)
  })

  it('finds a session stored as its hash', () => {
    const accountData = {
      sessions: [{ token: hashSessionToken(authToken), expiry: now + SESSION_EXPIRY_MS }],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(false)
  })

  it('returns true when expiry is not a valid finite number', () => {
    const accountData = {
      sessions: [
        {
          token: authToken,
          expiry: NaN,
        },
      ],
    }

    expect(shouldRenewSession(accountData, authToken, now)).toBe(true)
  })
})

describe('protectedProcedure session renewal behavior', () => {
  const executionOrder: string[] = []

  const testRouter = router({
    testAction: protectedProcedure.mutation(async () => {
      executionOrder.push('procedure-body')
      return { success: true }
    }),
    failingAction: protectedProcedure.mutation(async () => {
      executionOrder.push('procedure-failing-body')
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'intentional error' })
    }),
  })

  function createMockContext(options: {
    authToken?: string
    expiry?: number
    extendSessionMock?: () => Promise<void>
  } = {}) {
    executionOrder.length = 0
    const authToken = options.authToken ?? 'valid-session-token'
    const now = Date.now()
    const expiry = options.expiry ?? (now + SESSION_EXPIRY_MS)

    const extendSession = vi.fn(async () => {
      executionOrder.push('extend-session')
      if (options.extendSessionMock) {
        await options.extendSessionMock()
      }
    })

    const getAccount = vi.fn(async () => {
      executionOrder.push('get-account')
      return {
        account: 'acc-1',
        authToken: 'stored-hash',
        sessions: [
          { token: authToken, expiry },
        ],
      } as VaultAccountWithAuth
    })

    const vault = {
      getAccount,
      extendSession,
    }

    return {
      authToken,
      vault,
    }
  }

  it('does NOT call extendSession when session is fresh (> 29 days remaining)', async () => {
    const ctx = createMockContext({
      expiry: Date.now() + SESSION_EXPIRY_MS, // fresh 30-day session
    })
    const caller = testRouter.createCaller(ctx as any)

    const result = await caller.testAction({ account: 'acc-1' })

    expect(result).toEqual({ success: true })
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
    expect(ctx.vault.extendSession).not.toHaveBeenCalled()
    expect(executionOrder).toEqual(['get-account', 'procedure-body'])
  })

  it('forks and awaits extendSession when renewal threshold is reached', async () => {
    let extendSessionFinished = false
    const ctx = createMockContext({
      expiry: Date.now() + SESSION_RENEWAL_THRESHOLD_MS - 5000, // needs renewal
      extendSessionMock: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        extendSessionFinished = true
      },
    })
    const caller = testRouter.createCaller(ctx as any)

    const result = await caller.testAction({ account: 'acc-1' })

    expect(result).toEqual({ success: true })
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
    expect(ctx.vault.extendSession).toHaveBeenCalledWith({
      account: 'acc-1',
      session: 'valid-session-token',
    })
    // Fork-join: extendSession is forked before procedure-body and awaited before completion
    expect(executionOrder).toEqual(['get-account', 'extend-session', 'procedure-body'])
    expect(extendSessionFinished).toBe(true)
  })

  it('still forks and awaits extendSession when the procedure fails', async () => {
    let extendSessionFinished = false
    const ctx = createMockContext({
      expiry: Date.now() + SESSION_RENEWAL_THRESHOLD_MS - 5000, // needs renewal
      extendSessionMock: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        extendSessionFinished = true
      },
    })
    const caller = testRouter.createCaller(ctx as any)

    await expect(caller.failingAction({ account: 'acc-1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })

    expect(ctx.vault.extendSession).toHaveBeenCalledWith({
      account: 'acc-1',
      session: 'valid-session-token',
    })
    expect(executionOrder).toEqual(['get-account', 'extend-session', 'procedure-failing-body'])
    expect(extendSessionFinished).toBe(true)
  })

  it('does not fail procedure result if extendSession throws', async () => {
    const ctx = createMockContext({
      expiry: Date.now() + SESSION_RENEWAL_THRESHOLD_MS - 5000,
      extendSessionMock: async () => {
        throw new Error('DynamoDB temporary outage')
      },
    })
    const caller = testRouter.createCaller(ctx as any)

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await caller.testAction({ account: 'acc-1' })

    expect(result).toEqual({ success: true })
    expect(ctx.vault.extendSession).toHaveBeenCalledTimes(1)
    expect(consoleSpy).toHaveBeenCalledWith(
      '[extendSession failed]',
      expect.any(Error),
    )

    consoleSpy.mockRestore()
  })
})

describe('protectedProcedure authentication errors', () => {
  const testRouter = router({
    testAction: protectedProcedure.query(() => 'ok'),
  })

  function createCaller(getAccount: () => Promise<unknown>) {
    return testRouter.createCaller({ authToken: 'token', vault: { getAccount, extendSession: vi.fn() } } as any)
  }

  it('rejects unknown accounts and invalid sessions as UNAUTHORIZED', async () => {
    await expect(createCaller(async () => {
      throw new AuthenticationError('Could not find account acc-1')
    }).testAction({ account: 'acc-1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })

    await expect(createCaller(async () => {
      throw new ExpiredSessionError('Invalid session token')
    }).testAction({ account: 'acc-1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('does not report a database failure as UNAUTHORIZED, which would end the session', async () => {
    await expect(createCaller(async () => {
      throw new Error('DynamoDB timeout')
    }).testAction({ account: 'acc-1' })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' })
  })
})

describe('protocol version gate', () => {
  const gatedRouter = router({
    read: publicProcedure.query(() => 'read'),
    write: publicProcedure.mutation(() => 'written'),
  })

  function createCaller(protocolVersion: number, minProtocolVersion: number) {
    return gatedRouter.createCaller({ authToken: '', vault: {} as any, protocolVersion, minProtocolVersion })
  }

  it('rejects writes from builds below the minimum protocol version', async () => {
    await expect(createCaller(0, 1).write()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'CLIENT_OUTDATED',
    })
  })

  it('still serves reads to builds below the minimum protocol version', async () => {
    await expect(createCaller(0, 1).read()).resolves.toBe('read')
  })

  it('accepts writes from builds at or above the minimum protocol version', async () => {
    await expect(createCaller(1, 1).write()).resolves.toBe('written')
    await expect(createCaller(0, 0).write()).resolves.toBe('written')
  })

  it('reads the protocol version header into the context', () => {
    const createContext = createVaultContext({ minProtocolVersion: 2 })
    const req = { headers: { 'x-vault-protocol': '3' }, server: { vault: {} } }
    expect(createContext({ req } as any)).toMatchObject({ protocolVersion: 3, minProtocolVersion: 2 })

    const reqWithoutHeader = { headers: {}, server: { vault: {} } }
    expect(createContext({ req: reqWithoutHeader } as any)).toMatchObject({ protocolVersion: 0 })
  })
})
