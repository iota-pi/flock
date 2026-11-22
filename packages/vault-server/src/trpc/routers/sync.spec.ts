import type { TRPCError } from '@trpc/server'
import { hashSessionToken, SESSION_EXPIRY_MS } from '../../sessions'
import { syncRouter } from './sync'
import { CLIENT_OUTDATED_MESSAGE, MAX_LOG_CIPHER_LENGTH, QUOTA_EXCEEDED_MESSAGE, type ItemId } from '@vault/shared'
import { DEFAULT_ACCOUNT_QUOTAS } from '../../quotas'
import { QuotaExceededError } from '../../errors'

function createContext(overrides?: {
  authToken?: string
  sessionValid?: boolean
}) {
  const sessionValid = overrides?.sessionValid ?? true
  const authToken = overrides?.authToken ?? 'valid-session-token'
  const vault = {
    extendSession: vi.fn(async () => undefined),
    getAccountRecord: vi.fn(async ({ account }: { account: string }) => ({
      account,
      // A session for another device when it isn't valid
      sessions: [{ token: hashSessionToken(sessionValid ? authToken : 'other-session-token'), expiry: Date.now() + SESSION_EXPIRY_MS }],
    })),
    updateAccountData: vi.fn(async () => undefined),
    appendLog: vi.fn(async () => [{ itemId: 'item-1' as ItemId, seq: 1 }]),
    readLog: vi.fn(async () => ({ entries: [], hasMore: false })),
  }

  return {
    authToken,
    vault,
    quotas: DEFAULT_ACCOUNT_QUOTAS,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pollLog', () => {
  const input = {
    account: 'target-account',
    push: [{ itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv', cipher: 'cipher', format: 2 as const } }],
    after: 0,
  }

  it('rejects a poll with no session, and stores nothing', async () => {
    const ctx = createContext({ authToken: '' })
    const caller = syncRouter.createCaller(ctx as any)

    await expect(caller.pollLog(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' } satisfies Partial<TRPCError>)
    expect(ctx.vault.appendLog).not.toHaveBeenCalled()
  })

  it('rejects a session of another account, and stores nothing', async () => {
    const ctx = createContext({ sessionValid: false })
    const caller = syncRouter.createCaller(ctx as any)

    await expect(caller.pollLog(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' } satisfies Partial<TRPCError>)
    expect(ctx.vault.appendLog).not.toHaveBeenCalled()
  })

  it('rejects a build below the minimum protocol version', async () => {
    const ctx = createContext()
    const caller = syncRouter.createCaller({ ...ctx, protocolVersion: 4, minProtocolVersion: 5 } as any)

    await expect(caller.pollLog(input)).rejects.toMatchObject({ message: CLIENT_OUTDATED_MESSAGE })
    expect(ctx.vault.appendLog).not.toHaveBeenCalled()
  })

  it('keeps the ciphertext format on its way to the driver', async () => {
    const ctx = createContext()
    const caller = syncRouter.createCaller(ctx as any)

    const result = await caller.pollLog(input)

    expect(ctx.vault.appendLog).toHaveBeenCalledWith({
      account: 'target-account',
      messages: input.push,
      maxBytesPerDay: DEFAULT_ACCOUNT_QUOTAS.logBytesPerDay,
    })
    expect(result).toEqual({
      pushResults: [{ itemId: 'item-1', seq: 1 }],
      entries: [],
      hasMore: false,
      serverNow: expect.any(Number),
    })
  })

  it('requires a position to read after', async () => {
    const ctx = createContext()
    const caller = syncRouter.createCaller(ctx as any)

    await expect(caller.pollLog({ account: 'target-account', push: [] } as any))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>)
  })

  it('refuses a row longer than a client could send, and stores nothing', async () => {
    const ctx = createContext()
    const caller = syncRouter.createCaller(ctx as any)
    const oversized = { ...input.push[0], encryptedMessage: { ...input.push[0].encryptedMessage, cipher: 'a'.repeat(600 * 1024) } }

    await expect(caller.pollLog({ ...input, push: [oversized] }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' } satisfies Partial<TRPCError>)
    expect(ctx.vault.appendLog).not.toHaveBeenCalled()
  })

  it('accepts a row of the longest length allowed', async () => {
    const ctx = createContext()
    const caller = syncRouter.createCaller(ctx as any)
    const largest = { ...input.push[0], encryptedMessage: { ...input.push[0].encryptedMessage, cipher: 'a'.repeat(MAX_LOG_CIPHER_LENGTH) } }

    await caller.pollLog({ ...input, push: [largest] })

    expect(ctx.vault.appendLog).toHaveBeenCalledWith(expect.objectContaining({ messages: [largest] }))
  })
})

describe('pollLog quota', () => {
  const input = {
    account: 'target-account',
    push: [{ itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv', cipher: 'cipher', format: 2 as const } }],
    after: 0,
  }

  it('passes the daily log quota to the append', async () => {
    const ctx = createContext()
    await syncRouter.createCaller(ctx as any).pollLog(input)

    expect(ctx.vault.appendLog).toHaveBeenCalledWith(expect.objectContaining({
      maxBytesPerDay: DEFAULT_ACCOUNT_QUOTAS.logBytesPerDay,
    }))
  })

  it('answers TOO_MANY_REQUESTS with QUOTA_EXCEEDED when the push passes it', async () => {
    const ctx = createContext()
    ctx.vault.appendLog.mockRejectedValueOnce(new QuotaExceededError('over'))

    await expect(syncRouter.createCaller(ctx as any).pollLog(input)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: QUOTA_EXCEEDED_MESSAGE,
    })
  })
})
