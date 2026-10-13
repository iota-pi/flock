import { TRPCError } from '@trpc/server'
import {
  router,
  protectedProcedure,
  shouldRenewSession,
  SESSION_EXPIRY_MS,
  SESSION_RENEWAL_THRESHOLD_MS,
} from './trpc'
import type { VaultAccountWithAuth, VaultSessionRecord } from '../drivers/base'

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

  it('calls and awaits extendSession AFTER the procedure body when renewal threshold is reached', async () => {
    const ctx = createMockContext({
      expiry: Date.now() + SESSION_RENEWAL_THRESHOLD_MS - 5000, // needs renewal
    })
    const caller = testRouter.createCaller(ctx as any)

    const result = await caller.testAction({ account: 'acc-1' })

    expect(result).toEqual({ success: true })
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
    expect(ctx.vault.extendSession).toHaveBeenCalledWith({
      account: 'acc-1',
      session: 'valid-session-token',
    })
    // Crucial: procedure-body executed BEFORE extend-session
    expect(executionOrder).toEqual(['get-account', 'procedure-body', 'extend-session'])
  })

  it('does NOT call extendSession when the procedure fails', async () => {
    const ctx = createMockContext({
      expiry: Date.now() + SESSION_RENEWAL_THRESHOLD_MS - 5000, // needs renewal
    })
    const caller = testRouter.createCaller(ctx as any)

    await expect(caller.failingAction({ account: 'acc-1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })

    expect(ctx.vault.extendSession).not.toHaveBeenCalled()
    expect(executionOrder).toEqual(['get-account', 'procedure-failing-body'])
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
