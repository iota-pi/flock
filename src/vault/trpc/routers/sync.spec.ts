import { TRPCError } from '@trpc/server'
import { syncRouter } from './sync'

function createContext(overrides?: {
  authToken?: string
  checkSessionSuccess?: boolean
  latestSyncCursor?: number
}) {
  const checkSessionSuccess = overrides?.checkSessionSuccess ?? true
  const vault = {
    checkSession: vi.fn(async ({ account, session }: { account: string; session: string }) => {
      if (!checkSessionSuccess) {
        return { success: false, reason: 'Invalid session' }
      }
      return { success: true }
    }),
    extendSession: vi.fn(async () => undefined),
    getAccount: vi.fn(async ({ account, session }: { account: string; session: string }) => {
      if (!checkSessionSuccess) {
        throw new Error('Unauthorized')
      }
      return {
        account,
        latestSyncCursor: overrides?.latestSyncCursor ?? 100,
        sessions: [{ token: session, expires: Date.now() + 10000 }],
      }
    }),
    updateAccountData: vi.fn(async () => undefined),
    getGlobalSyncMessagesAfterCursor: vi.fn(async () => ({ messages: [], hasMore: false })),
    getSyncMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
    pushSyncMessagesBatch: vi.fn(async () => undefined),
  }

  return {
    authToken: overrides?.authToken ?? 'valid-session-token',
    vault,
  }
}

describe('syncRouter authorization & IDOR protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const samplePushInput = {
    account: 'target-account',
    messages: [
      {
        itemId: 'item-1' as any,
        encryptedMessage: {
          iv: 'test-iv',
          cipher: 'test-cipher',
        },
      },
    ],
  }

  it('rejects pushBatch when unauthenticated (missing auth token)', async () => {
    const ctx = createContext({ authToken: '' })
    const caller = syncRouter.createCaller(ctx as any)

    await expect(caller.pushBatch(samplePushInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>)
    expect(ctx.vault.pushSyncMessagesBatch).not.toHaveBeenCalled()
  })

  it('rejects pushBatch when session does not belong to target account (IDOR protection)', async () => {
    const ctx = createContext({ checkSessionSuccess: false })
    const caller = syncRouter.createCaller(ctx as any)

    await expect(caller.pushBatch(samplePushInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>)
    expect(ctx.vault.checkSession).toHaveBeenCalledWith({
      account: 'target-account',
      session: 'valid-session-token',
    })
    expect(ctx.vault.pushSyncMessagesBatch).not.toHaveBeenCalled()
  })

  it('allows pushBatch when session is valid for the account', async () => {
    const ctx = createContext({ checkSessionSuccess: true })
    const caller = syncRouter.createCaller(ctx as any)

    const result = await caller.pushBatch(samplePushInput)
    expect(result.success).toBe(true)
    expect(ctx.vault.checkSession).toHaveBeenCalledWith({
      account: 'target-account',
      session: 'valid-session-token',
    })
    expect(ctx.vault.pushSyncMessagesBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        account: 'target-account',
      })
    )
  })

  it('rejects pollSync when session does not belong to target account', async () => {
    const ctx = createContext({ checkSessionSuccess: false })
    const caller = syncRouter.createCaller(ctx as any)

    await expect(
      caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [],
      })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>)
    expect(ctx.vault.checkSession).toHaveBeenCalledWith({
      account: 'target-account',
      session: 'valid-session-token',
    })
  })
})
