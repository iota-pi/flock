import { TRPCError } from '@trpc/server'
import { syncRouter } from './sync'
import { StoredSyncMessage } from '../../drivers/base'
import { ItemId } from '@vault/shared/ids'
import DynamoDriver from '../../drivers/dynamo'

/** A page token as the Dynamo driver issues it */
function pageToken(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString('base64url')
}

function createContext(overrides?: {
  authToken?: string
  sessionValid?: boolean
}) {
  const sessionValid = overrides?.sessionValid ?? true
  const vault = {
    extendSession: vi.fn(async () => undefined),
    getAccount: vi.fn(async ({ account, session }: { account: string; session: string }) => {
      if (!sessionValid) {
        throw new Error('Unauthorized')
      }
      return {
        account,
        sessions: [{ token: session, expires: Date.now() + 10000 }],
      }
    }),
    updateAccountData: vi.fn(async () => undefined),
    getGlobalSyncMessagesAfterCursor: vi.fn(async (): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; nextPageToken?: string }> => ({ items: [], hasMore: false })),
    getSyncMessages: vi.fn(async (): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; nextPageToken?: string }> => ({ messages: [], hasMore: false })),
    pushSyncMessagesBatch: vi.fn(async () => undefined),
    // The Dynamo driver's token checks, which need no connection
    validatePageToken: vi.fn((input: Parameters<DynamoDriver['validatePageToken']>[0]) => new DynamoDriver().validatePageToken(input)),
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
    const ctx = createContext({ sessionValid: false })
    const caller = syncRouter.createCaller(ctx as any)

    await expect(caller.pushBatch(samplePushInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    } satisfies Partial<TRPCError>)
    expect(ctx.vault.getAccount).toHaveBeenCalledWith({
      account: 'target-account',
      session: 'valid-session-token',
    })
    expect(ctx.vault.pushSyncMessagesBatch).not.toHaveBeenCalled()
  })

  it('allows pushBatch when session is valid for the account', async () => {
    const ctx = createContext({ sessionValid: true })
    const caller = syncRouter.createCaller(ctx as any)

    const result = await caller.pushBatch(samplePushInput)
    expect(result.success).toBe(true)
    expect(ctx.vault.getAccount).toHaveBeenCalledWith({
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
    const ctx = createContext({ sessionValid: false })
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
    expect(ctx.vault.getAccount).toHaveBeenCalledWith({
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

    // Critical assertion: getAccount is called once in protectedProcedure for session auth, not in pollSync
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
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

    // Critical assertion: getAccount is called once in protectedProcedure for auth, and updateAccountData is NOT called on push (no OCC contention)
    expect(ctx.vault.getAccount).toHaveBeenCalledTimes(1)
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

    it('forwards the page token in pullCursors and returns the next one in item pull results', async () => {
      const ctx = createContext()
      const itemToken = pageToken({ syncId: 'target-account#item-1', cursor: 200 })
      ctx.vault.getSyncMessages.mockResolvedValueOnce({
        messages: [
          {
            cursor: 250,
            encryptedMessage: { iv: 'iv', cipher: 'cipher' },
            createdAt: 1000,
          },
        ],
        hasMore: true,
        nextPageToken: 'next-item-token',
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [{ itemId: 'item-1' as ItemId, cursor: 200, pageToken: itemToken }],
      })

      expect(result.success).toBe(true)
      expect(ctx.vault.getSyncMessages).toHaveBeenCalledWith({
        account: 'target-account',
        itemId: 'item-1',
        fromCursor: 200,
        limit: 200,
        pageToken: itemToken,
      })
      expect(result.pullResults).toHaveLength(1)
      expect(result.pullResults[0].itemId).toBe('item-1')
      expect(result.pullResults[0].nextCursor).toBe(250)
      expect(result.pullResults[0].nextPageToken).toBe('next-item-token')
    })

    it('forwards the global page token and returns the next one in the response', async () => {
      const ctx = createContext()
      const globalToken = pageToken({ account: 'target-account', cursor: 500, syncId: 'target-account#item-x' })

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
        nextPageToken: 'next-global-token',
      })

      const caller = syncRouter.createCaller(ctx as any)
      const result = await caller.pollSync({
        account: 'target-account',
        pushMessages: [],
        pullCursors: [],
        globalPageToken: globalToken,
      })

      expect(result.success).toBe(true)
      expect(ctx.vault.getGlobalSyncMessagesAfterCursor).toHaveBeenCalledWith({
        account: 'target-account',
        cursor: 0,
        pageToken: globalToken,
      })
      expect(result.hasMore).toBe(true)
      expect(result.globalNextPageToken).toBe('next-global-token')
      expect(result.pullResults).toHaveLength(1)
    })

    it('accepts a global page token whose cursor precedes clientLatestCursor', async () => {
      const ctx = createContext()
      ctx.vault.getGlobalSyncMessagesAfterCursor.mockResolvedValueOnce({
        items: [{ itemId: 'item-a' as ItemId, messages: [{ cursor: 1200, encryptedMessage: { iv: 'iv', cipher: 'c' }, createdAt: 1 }] }],
        hasMore: true,
        nextPageToken: 'next-global-token',
        scannedThroughCursor: 1200,
      } as any)
      const caller = syncRouter.createCaller(ctx as any)

      const result = await caller.pollSync({
        account: 'target-account',
        clientLatestCursor: 1000,
        pushMessages: [],
        pullCursors: [],
        globalPageToken: pageToken({ account: 'target-account', cursor: 999, syncId: 'target-account#item-x' }),
      })

      expect(result.success).toBe(true)
      expect(result.globalHasMore).toBe(true)
      expect(result.globalScannedThroughCursor).toBe(1200)
    })

    it('reports global scan state separately from per-item pagination', async () => {
      const ctx = createContext()
      ctx.vault.getSyncMessages.mockResolvedValueOnce({
        messages: [{ cursor: 5000, encryptedMessage: { iv: 'iv', cipher: 'c' }, createdAt: 1 }],
        hasMore: true,
        nextPageToken: 'item-lagging-token',
      })
      ctx.vault.getGlobalSyncMessagesAfterCursor.mockResolvedValueOnce({
        items: [
          { itemId: 'item-lagging' as ItemId, messages: [{ cursor: 300, encryptedMessage: { iv: 'iv', cipher: 'c' }, createdAt: 1 }] },
          { itemId: 'item-other' as ItemId, messages: [{ cursor: 200, encryptedMessage: { iv: 'iv', cipher: 'c' }, createdAt: 1 }] },
        ],
        hasMore: false,
        scannedThroughCursor: 300,
      } as any)
      const caller = syncRouter.createCaller(ctx as any)

      const result = await caller.pollSync({
        account: 'target-account',
        clientLatestCursor: 100,
        pushMessages: [],
        pullCursors: [{ itemId: 'item-lagging' as ItemId, cursor: 4000 }],
      })

      expect(result.pullResults.map(r => r.itemId).sort()).toEqual(['item-lagging', 'item-other'])
      // The filtered-out global message for item-lagging still counts towards the scan position
      expect(result.globalScannedThroughCursor).toBe(300)
      expect(result.globalHasMore).toBe(false)
      expect(result.hasMore).toBe(true)
    })

    it.each([
      {
        name: 'a global page token for another account',
        input: { globalPageToken: pageToken({ account: 'other-account', cursor: 500, syncId: 'other-account#item-x' }) },
        message: 'Page token is for another account',
      },
      {
        name: 'a global page token whose syncId belongs to another account',
        input: { globalPageToken: pageToken({ account: 'target-account', cursor: 500, syncId: 'other-account#item-x' }) },
        message: 'Page token is for another account',
      },
      {
        name: 'an item page token for another item',
        input: { pullCursors: [{ itemId: 'item-1', cursor: 100, pageToken: pageToken({ syncId: 'target-account#item-2', cursor: 150 }) }] },
        message: 'Page token is for another item',
      },
      {
        name: 'an item page token that starts before the pull cursor',
        input: { pullCursors: [{ itemId: 'item-1', cursor: 500, pageToken: pageToken({ syncId: 'target-account#item-1', cursor: 499 }) }] },
        message: 'Page token cannot start before cursor 500',
      },
      {
        name: 'an undecodable page token',
        input: { pullCursors: [{ itemId: 'item-1', cursor: 500, pageToken: 'not-a-token' }] },
        message: 'Page token is malformed',
      },
      {
        name: 'a page token with unexpected fields',
        input: { pullCursors: [{ itemId: 'item-1', cursor: 500, pageToken: pageToken({ syncId: 'target-account#item-1', cursor: 500, extra: true }) }] },
        message: 'Page token is malformed',
      },
    ])('rejects $name before storing pushed messages', async ({ input, message }) => {
      const ctx = createContext()
      const caller = syncRouter.createCaller(ctx as any)

      const error = await caller.pollSync({
        account: 'target-account',
        pushMessages: [{ itemId: 'item-1' as ItemId, encryptedMessage: { iv: 'iv', cipher: 'c' } }],
        pullCursors: [],
        ...input,
      } as Parameters<typeof caller.pollSync>[0]).catch(e => e)

      expect(error).toBeInstanceOf(TRPCError)
      expect(error.code).toBe('BAD_REQUEST')
      expect(error.message).toContain(message)
      // The client would push the stored messages again with its retried poll
      expect(ctx.vault.pushSyncMessagesBatch).not.toHaveBeenCalled()
    })
  })
})

