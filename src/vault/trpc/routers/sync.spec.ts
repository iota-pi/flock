import { TRPCError } from '@trpc/server'
import { syncRouter } from './sync'
import { StoredSyncMessage } from 'src/vault/drivers/base'
import { ItemId } from 'src/shared/schemas/items'

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
    getGlobalSyncMessagesAfterCursor: vi.fn(async () => ({ items: [] as Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>, hasMore: false })),
    getSyncMessages: vi.fn(async () => ({ messages: [] as StoredSyncMessage[], hasMore: false })),
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
        itemId: 'item-1' as ItemId,
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

describe('pollSync behavior (C1 resolution: fast path removal & deferred getAccount)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does NOT call getAccount on idle poll with clientLatestCursor and always queries GSI', async () => {
    const ctx = createContext({ latestSyncCursor: 100 })
    ctx.vault.getGlobalSyncMessagesAfterCursor.mockResolvedValueOnce({
      items: [
        {
          itemId: 'item-1' as ItemId,
          messages: [
            {
              cursor: 120,
              encryptedMessage: { iv: 'iv1', cipher: 'c1' },
              createdAt: Date.now(),
            },
          ],
        },
      ],
      hasMore: false,
    })

    const caller = syncRouter.createCaller(ctx as any)
    const result = await caller.pollSync({
      account: 'target-account',
      pushMessages: [],
      pullCursors: [],
      clientLatestCursor: 50,
    })

    expect(result.success).toBe(true)
    expect(result.pushResults).toEqual([])
    expect(result.pullResults.length).toBe(1)
    expect(result.pullResults[0].itemId).toBe('item-1')
    expect(result.pullResults[0].nextCursor).toBe(120)

    // Critical assertion: getAccount is NOT called on idle polls
    expect(ctx.vault.getAccount).not.toHaveBeenCalled()
    // Critical assertion: global GSI query is executed
    expect(ctx.vault.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledTimes(1)
  })

  it('queries GSI even when clientLatestCursor >= account.latestSyncCursor (proves fast path is eliminated)', async () => {
    const ctx = createContext({ latestSyncCursor: 100 })
    const caller = syncRouter.createCaller(ctx as any)

    // In the old buggy code, clientLatestCursor = 500 >= 100 would trigger the fast path
    // and skip getGlobalSyncMessagesAfterCursor entirely.
    const result = await caller.pollSync({
      account: 'target-account',
      pushMessages: [],
      pullCursors: [],
      clientLatestCursor: 500,
    })

    expect(result.success).toBe(true)
    expect(ctx.vault.getAccount).not.toHaveBeenCalled()
    expect(ctx.vault.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledTimes(1)
  })

  it('fetches getAccount and advances latestSyncCursor when push messages are provided', async () => {
    const ctx = createContext({ latestSyncCursor: 100 })
    const caller = syncRouter.createCaller(ctx as any)

    const result = await caller.pollSync({
      account: 'target-account',
      pushMessages: [
        {
          itemId: 'item-1' as ItemId,
          encryptedMessage: { iv: 'iv', cipher: 'c' },
        },
      ],
      pullCursors: [],
      clientLatestCursor: 50,
    })

    expect(result.success).toBe(true)
    expect(result.pushResults.length).toBe(1)
    const pushedCursor = result.pushResults[0].cursor
    expect(pushedCursor).toBeGreaterThan(0)

    // getAccount should be called because pushMessages is non-empty
    expect(ctx.vault.getAccount).toHaveBeenCalledWith({
      account: 'target-account',
      session: 'valid-session-token',
    })

    // updateAccountData should be called with the pushed cursor
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'target-account',
      latestSyncCursor: pushedCursor,
    })
  })

  it('skips updateAccountData if currentAccount.latestSyncCursor is already >= maxPushCursor', async () => {
    // Account already has a massive latestSyncCursor
    const ctx = createContext({ latestSyncCursor: Number.MAX_SAFE_INTEGER })
    const caller = syncRouter.createCaller(ctx as any)

    const result = await caller.pollSync({
      account: 'target-account',
      pushMessages: [
        {
          itemId: 'item-1' as ItemId,
          encryptedMessage: { iv: 'iv', cipher: 'c' },
        },
      ],
      pullCursors: [],
    })

    expect(result.success).toBe(true)
    expect(result.pushResults.length).toBe(1)
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
    // Should NOT call updateAccountData since currentAccount.latestSyncCursor is already higher
    expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
  })

  it('retries and handles ConditionalCheckFailedException during cursor advance', async () => {
    const ctx = createContext({ latestSyncCursor: 10 })
    let callCount = 0
    ctx.vault.updateAccountData.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        const error = new Error('ConditionalCheckFailedException')
        error.name = 'ConditionalCheckFailedException'
        throw error
      }
      return undefined
    })

    const caller = syncRouter.createCaller(ctx as any)
    const result = await caller.pollSync({
      account: 'target-account',
      pushMessages: [
        {
          itemId: 'item-1' as ItemId,
          encryptedMessage: { iv: 'iv', cipher: 'c' },
        },
      ],
      pullCursors: [],
    })

    expect(result.success).toBe(true)
    // First attempt failed with ConditionalCheckFailed, re-read account, second attempt succeeded
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(2)
    expect(ctx.vault.updateAccountData).toHaveBeenCalledTimes(2)
  })

  describe('concurrent pullCursors and clientLatestCursor (B3 resolution)', () => {
    it('executes both batch pull for pullCursors and global pull for clientLatestCursor concurrently, filtering out lagging items from global results', async () => {
      const ctx = createContext()
      ctx.vault.getSyncMessages.mockResolvedValueOnce({
        messages: [
          {
            cursor: 60,
            encryptedMessage: { iv: 'iv-b', cipher: 'cipher-b' },
            createdAt: 1000,
          },
        ],
        hasMore: false,
      })

      ctx.vault.getGlobalSyncMessagesAfterCursor.mockResolvedValueOnce({
        items: [
          {
            itemId: 'item-a' as ItemId,
            messages: [
              {
                cursor: 2000010,
                encryptedMessage: { iv: 'iv-a', cipher: 'cipher-a' },
                createdAt: 2000,
              },
            ],
          },
          {
            // Even if global query also returned a newer message for item-b,
            // it must be filtered out so lagging item-b doesn't skip missing messages.
            itemId: 'item-b' as ItemId,
            messages: [
              {
                cursor: 2000020,
                encryptedMessage: { iv: 'iv-b2', cipher: 'cipher-b2' },
                createdAt: 2001,
              },
            ],
          },
        ],
        hasMore: false,
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [{ itemId: 'item-b' as ItemId, cursor: 50 }],
        clientLatestCursor: 2000000000,
      })

      expect(result.success).toBe(true)
      // Both repository methods were called
      expect(ctx.vault.getSyncMessages).toHaveBeenCalledTimes(1)
      expect(ctx.vault.getSyncMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          account: 'target-account',
          itemId: 'item-b',
        })
      )
      expect(ctx.vault.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledTimes(1)
      expect(ctx.vault.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledWith(
        expect.objectContaining({
          account: 'target-account',
        })
      )

      // item-b should come from batch pull (cursor 60)
      const itemBResult = result.pullResults.find(r => r.itemId === 'item-b')
      expect(itemBResult).toBeDefined()
      expect(itemBResult?.messages).toHaveLength(1)
      expect(itemBResult?.messages[0].cursor).toBe(60)

      // item-a should come from global pull (cursor 2000010)
      const itemAResult = result.pullResults.find(r => r.itemId === 'item-a')
      expect(itemAResult).toBeDefined()
      expect(itemAResult?.messages).toHaveLength(1)
      expect(itemAResult?.messages[0].cursor).toBe(2000010)

      // pullResults total should be 2, not 3 (global item-b duplicate was filtered out)
      expect(result.pullResults).toHaveLength(2)
    })

    it('executes only batch pull when clientLatestCursor is undefined', async () => {
      const ctx = createContext()
      ctx.vault.getSyncMessages.mockResolvedValueOnce({
        messages: [
          {
            cursor: 75,
            encryptedMessage: { iv: 'iv', cipher: 'cipher' },
            createdAt: 1000,
          },
        ],
        hasMore: false,
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [{ itemId: 'item-b' as ItemId, cursor: 50 }],
      })

      expect(result.success).toBe(true)
      expect(ctx.vault.getSyncMessages).toHaveBeenCalledTimes(1)
      expect(ctx.vault.getGlobalSyncMessagesAfterCursor).not.toHaveBeenCalled()
      expect(result.pullResults).toHaveLength(1)
      expect(result.pullResults[0].itemId).toBe('item-b')
      expect(result.pullResults[0].messages[0].cursor).toBe(75)
    })

    it('executes only global pull when pullCursors is empty', async () => {
      const ctx = createContext()
      ctx.vault.getGlobalSyncMessagesAfterCursor.mockResolvedValueOnce({
        items: [
          {
            itemId: 'item-a' as ItemId,
            messages: [
              {
                cursor: 120,
                encryptedMessage: { iv: 'iv', cipher: 'cipher' },
                createdAt: 1000,
              },
            ],
          },
        ],
        hasMore: false,
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [],
        clientLatestCursor: 100,
      })

      expect(result.success).toBe(true)
      expect(ctx.vault.getSyncMessages).not.toHaveBeenCalled()
      expect(ctx.vault.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledTimes(1)
      expect(result.pullResults).toHaveLength(1)
      expect(result.pullResults[0].itemId).toBe('item-a')
    })
  })
})

