import { TRPCError } from '@trpc/server'
import { syncRouter } from './sync'
import { StoredSyncMessage } from 'src/vault/drivers/base'
import { ItemId } from 'src/shared/schemas/items'

function createContext(overrides?: {
  authToken?: string
  checkSessionSuccess?: boolean
}) {
  const checkSessionSuccess = overrides?.checkSessionSuccess ?? true
  const vault = {
    checkSession: vi.fn(async (_: { account: string; session: string }) => {
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
        sessions: [{ token: session, expires: Date.now() + 10000 }],
      }
    }),
    updateAccountData: vi.fn(async () => undefined),
    getGlobalSyncMessagesAfterCursor: vi.fn(async (): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; lastEvaluatedKey?: Record<string, unknown> }> => ({ items: [], hasMore: false })),
    getSyncMessages: vi.fn(async (): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; lastEvaluatedKey?: Record<string, unknown> }> => ({ messages: [], hasMore: false })),
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

describe('pollSync behavior and account isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('queries GSI and formats pull results on idle poll without touching account data', async () => {
    const ctx = createContext()
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

  it('pushes messages and returns pushResults without touching account data (zero OCC contention)', async () => {
    const ctx = createContext()
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

    // Critical assertion: getAccount and updateAccountData are NOT called on push (no OCC contention)
    expect(ctx.vault.getAccount).not.toHaveBeenCalled()
    expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
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

    it('returns top-level hasMore: true when global pull indicates more messages exist', async () => {
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
        hasMore: true,
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [],
        clientLatestCursor: 100,
      })

      expect(result.success).toBe(true)
      expect(result.hasMore).toBe(true)
      expect(result.pullResults).toHaveLength(1)
      expect(result.pullResults[0].hasMore).toBe(false)
    })

    it('forwards lastEvaluatedKey in pullCursors and returns it in item pull results', async () => {
      const ctx = createContext()
      const sampleItemKey = { syncId: 'target-account#item-1', cursor: 200 }
      ctx.vault.getSyncMessages.mockResolvedValueOnce({
        messages: [
          {
            cursor: 250,
            encryptedMessage: { iv: 'iv', cipher: 'cipher' },
            createdAt: 1000,
          },
        ],
        hasMore: false,
        lastEvaluatedKey: undefined,
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [{ itemId: 'item-1' as ItemId, cursor: 200, lastEvaluatedKey: sampleItemKey }],
      })

      expect(result.success).toBe(true)
      expect(ctx.vault.getSyncMessages).toHaveBeenCalledWith({
        account: 'target-account',
        itemId: 'item-1',
        fromCursor: undefined,
        limit: 200,
        exclusiveStartKey: sampleItemKey,
      })
      expect(result.pullResults).toHaveLength(1)
      expect(result.pullResults[0].itemId).toBe('item-1')
      expect(result.pullResults[0].nextCursor).toBe(250)
    })

    it('forwards globalLastEvaluatedKey and returns top-level globalLastEvaluatedKey in response', async () => {
      const ctx = createContext()
      const inputGlobalKey = { account: 'target-account', cursor: 500, syncId: 'target-account#item-x' }
      const outputGlobalKey = { account: 'target-account', cursor: 700, syncId: 'target-account#item-y' }

      ctx.vault.getGlobalSyncMessagesAfterCursor.mockResolvedValueOnce({
        items: [
          {
            itemId: 'item-y' as ItemId,
            messages: [
              {
                cursor: 700,
                encryptedMessage: { iv: 'iv', cipher: 'cipher' },
                createdAt: 2000,
              },
            ],
          },
        ],
        hasMore: true,
        lastEvaluatedKey: outputGlobalKey,
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [],
        globalLastEvaluatedKey: inputGlobalKey,
      })

      expect(result.success).toBe(true)
      expect(ctx.vault.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledWith({
        account: 'target-account',
        cursor: undefined,
        exclusiveStartKey: inputGlobalKey,
      })
      expect(result.hasMore).toBe(true)
      expect(result.globalLastEvaluatedKey).toEqual(outputGlobalKey)
      expect(result.pullResults).toHaveLength(1)
    })
  })
})

