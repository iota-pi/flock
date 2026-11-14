import { itemsRouter } from './items'
import { hashSessionToken, SESSION_EXPIRY_MS } from '../../sessions'
import { DEFAULT_ACCOUNT_QUOTAS } from '../../quotas'
import { QUOTA_EXCEEDED_MESSAGE, type ItemId } from '@vault/shared'

function createContext(overrides?: { authToken?: string, sessionValid?: boolean, storageBytes?: number }) {
  const sessionValid = overrides?.sessionValid ?? true
  const authToken = overrides?.authToken ?? 'session-token'
  const vault = {
    getAccountRecord: vi.fn(async () => (sessionValid
      ? {
        account: 'acct-1',
        metadata: {},
        storageBytes: overrides?.storageBytes,
        sessions: [{ token: hashSessionToken(authToken), expiry: Date.now() + SESSION_EXPIRY_MS }],
      } as any
      : undefined)),
    extendSession: vi.fn(async () => undefined),
    set: vi.fn(async () => ({ version: 1, storageDelta: 0 })),
    addStorageUsage: vi.fn(async () => undefined),
    updateAccountData: vi.fn(async () => undefined),
    readLogHead: vi.fn(async () => 0),
  }

  return {
    authToken,
    vault,
    quotas: DEFAULT_ACCOUNT_QUOTAS,
  }
}

describe('itemsRouter.putSnapshots', () => {
  it('persists snapshots', async () => {
    const ctx = createContext()
    const caller = itemsRouter.createCaller(ctx as any)

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1',
          type: 'todo',
          modified: 12345,
          snapshot: {
            iv: 'iv-1',
            cipher: 'cipher-1',
          },
          snapshotCursor: 10,
        },
        {
          itemId: 'item-2',
          type: 'todo',
          modified: 12346,
          snapshot: {
            iv: 'iv-2',
            cipher: 'cipher-2',
          },
          snapshotCursor: 20,
        },
      ],
    }

    const result = await caller.putSnapshots(input)

    expect(result).toEqual({
      success: true,
      persisted: 2,
      total: 2,
      results: [
        { itemId: 'item-1', version: 1 },
        { itemId: 'item-2', version: 1 },
      ],
      logSeq: 0,
    })

    expect(ctx.vault.set).toHaveBeenCalledTimes(2)
  })

  it('returns success: false when one snapshot write fails', async () => {
    const ctx = createContext()
    ;(ctx.vault.set as any)
      .mockResolvedValueOnce({ version: 1 })
      .mockRejectedValueOnce(new Error('DynamoDB put failed'))
    const caller = itemsRouter.createCaller(ctx as any)

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1',
          type: 'todo',
          modified: 12345,
          snapshot: { iv: 'iv-1', cipher: 'cipher-1' },
          snapshotCursor: 10,
        },
        {
          itemId: 'item-2',
          type: 'todo',
          modified: 12346,
          snapshot: { iv: 'iv-2', cipher: 'cipher-2' },
          snapshotCursor: 20,
        },
      ],
    }

    const result = await caller.putSnapshots(input)

    expect(result).toEqual({
      success: false,
      persisted: 1,
      total: 2,
      results: [
        { itemId: 'item-1', version: 1 },
      ],
      logSeq: 0,
    })
  })

  it('returns success: false and persisted: 0 when all snapshot writes fail', async () => {
    const ctx = createContext()
    ;(ctx.vault.set as any).mockRejectedValue(new Error('All writes fail'))
    const caller = itemsRouter.createCaller(ctx as any)

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1',
          type: 'todo',
          modified: 12345,
          snapshot: { iv: 'iv-1', cipher: 'cipher-1' },
          snapshotCursor: 10,
        },
      ],
    }

    const result = await caller.putSnapshots(input)

    expect(result).toEqual({
      success: false,
      persisted: 0,
      total: 1,
      results: [],
      logSeq: 0,
    })
    expect(ctx.vault.updateAccountData).not.toHaveBeenCalled()
  })
})

describe('itemsRouter.fetchManifest', () => {
  it('returns manifest entries from the driver', async () => {
    const ctx = createContext()
    ;(ctx.vault as any).fetchManifest = vi.fn().mockResolvedValue([
      { itemId: 'item-1', modifiedAt: 123 },
      { itemId: 'item-2', modifiedAt: 456, isDeleted: true },
    ])
    const caller = itemsRouter.createCaller(ctx as any)

    const result = await caller.fetchManifest({ account: 'acct-1' })

    expect(result).toEqual({
      success: true,
      manifest: [
        { itemId: 'item-1', modifiedAt: 123 },
        { itemId: 'item-2', modifiedAt: 456, isDeleted: true },
      ],
      serverTime: expect.any(Number),
    })
    expect((ctx.vault as any).fetchManifest).toHaveBeenCalledWith({ account: 'acct-1' })
  })
})

describe('itemsRouter.fetchSnapshotsByIds', () => {
  it('returns full items matching the requested ids', async () => {
    const ctx = createContext()
    const mockItems = [
      {
        account: 'acct-1',
        item: 'item-1',
        metadata: { iv: 'iv-1', modified: 123 },
      },
    ]
    ;(ctx.vault as any).fetchByIds = vi.fn().mockResolvedValue(mockItems)
    const caller = itemsRouter.createCaller(ctx as any)

    const result = await caller.fetchSnapshotsByIds({
      account: 'acct-1',
      itemIds: ['item-1' as any],
    })

    expect(result).toEqual({
      success: true,
      items: [{ item: 'item-1', metadata: { iv: 'iv-1', modified: 123 } }],
      serverTime: expect.any(Number),
    })
    expect((ctx.vault as any).fetchByIds).toHaveBeenCalledWith({
      account: 'acct-1',
      itemIds: ['item-1'],
    })
  })

  describe('with a response limit', () => {
    const snapshotItem = (item: string, chars: number) => ({
      account: 'acct-1',
      item,
      metadata: { modified: 1 },
      snapshot: { iv: 'iv', cipher: 'c'.repeat(chars), format: 2 },
    })

    async function fetchWithLimit(maxResponseChars: number) {
      const ctx = createContext()
      ;(ctx.vault as any).fetchByIds = vi.fn().mockResolvedValue([
        snapshotItem('item-1', 60),
        snapshotItem('item-2', 60),
        snapshotItem('item-3', 60),
      ])
      const caller = itemsRouter.createCaller(ctx as any)
      return caller.fetchSnapshotsByIds({
        account: 'acct-1',
        itemIds: ['item-1', 'item-2', 'item-3'] as any,
        maxResponseChars,
      })
    }

    it('returns items until the next would pass it, deferring the rest', async () => {
      const result = await fetchWithLimit(150)

      expect(result.items.map(item => item.item)).toEqual(['item-1', 'item-2'])
      expect(result).toMatchObject({ deferred: ['item-3'] })
    })

    it('always returns at least one item, so the client can make progress', async () => {
      const result = await fetchWithLimit(10)

      expect(result.items.map(item => item.item)).toEqual(['item-1'])
      expect(result).toMatchObject({ deferred: ['item-2', 'item-3'] })
    })

    it('defers nothing when everything fits', async () => {
      const result = await fetchWithLimit(1000)

      expect(result.items).toHaveLength(3)
      expect(result).toMatchObject({ deferred: [] })
    })
  })
})

describe('itemsRouter.putSnapshots storage quota', () => {
  const snapshots = [{
    itemId: 'item-1' as ItemId,
    modified: 1,
    snapshot: { iv: 'iv', cipher: 'cipher' },
    snapshotCursor: 0,
  }]

  it('answers TOO_MANY_REQUESTS with QUOTA_EXCEEDED for an account at its quota', async () => {
    const ctx = createContext({ storageBytes: DEFAULT_ACCOUNT_QUOTAS.storageBytes })
    const caller = itemsRouter.createCaller(ctx as any)

    await expect(caller.putSnapshots({ account: 'acct-1', snapshots })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: QUOTA_EXCEEDED_MESSAGE,
    })
    expect(ctx.vault.set).not.toHaveBeenCalled()
  })

  it('accepts snapshots for an account under its quota', async () => {
    const ctx = createContext({ storageBytes: DEFAULT_ACCOUNT_QUOTAS.storageBytes - 1 })
    const caller = itemsRouter.createCaller(ctx as any)

    await expect(caller.putSnapshots({ account: 'acct-1', snapshots })).resolves.toMatchObject({ success: true })
  })
})
