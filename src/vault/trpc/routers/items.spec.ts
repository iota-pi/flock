import { itemsRouter } from './items'

function createContext(overrides?: { authToken?: string, checkSessionSuccess?: boolean }) {
  const checkSessionSuccess = overrides?.checkSessionSuccess ?? true
  const vault = {
    checkSession: vi.fn(async () => ({ success: checkSessionSuccess })),
    extendSession: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    updateAccountData: vi.fn(async () => undefined),
  }

  return {
    authToken: overrides?.authToken ?? 'session-token',
    vault,
  }
}

describe('itemsRouter.putSnapshots', () => {
  it('persists snapshots and updates account data', async () => {
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
    })

    expect(ctx.vault.set).toHaveBeenCalledTimes(2)
    expect(ctx.vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      lastSnapshotCursor: 20,
      lastSnapshotAt: expect.any(Number),
    })
  })
})

describe('itemsRouter.fetchManifest', () => {
  it('returns manifest tuples from the driver', async () => {
    const ctx = createContext()
    ;(ctx.vault as any).fetchManifest = vi.fn().mockResolvedValue([
      { itemId: 'item-1', modifiedAt: 123 },
      { itemId: 'item-2', modifiedAt: 456 },
    ])
    const caller = itemsRouter.createCaller(ctx as any)

    const result = await caller.fetchManifest({ account: 'acct-1' })

    expect(result).toEqual({
      success: true,
      manifest: [
        ['item-1', 123],
        ['item-2', 456],
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
        metadata: { type: 'person', iv: 'iv-1', modified: 123 },
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
      items: mockItems,
      serverTime: expect.any(Number),
    })
    expect((ctx.vault as any).fetchByIds).toHaveBeenCalledWith({
      account: 'acct-1',
      itemIds: ['item-1'],
    })
  })
})
