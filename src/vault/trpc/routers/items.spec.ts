import { itemsRouter } from './items'

function createContext(overrides?: { authToken?: string, checkSessionSuccess?: boolean }) {
  const checkSessionSuccess = overrides?.checkSessionSuccess ?? true
  const vault = {
    checkSession: vi.fn(async () => ({ success: checkSessionSuccess })),
    extendSession: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    updateAccountData: vi.fn(async () => undefined),
    pruneSyncMessagesUpToCursor: vi.fn(async () => 0),
  }

  return {
    authToken: overrides?.authToken ?? 'session-token',
    vault,
  }
}

describe('itemsRouter.putSnapshots', () => {
  let consoleErrorSpy: any

  beforeEach(() => {
    vi.clearAllMocks()
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy.mockRestore()
  })

  it('persists snapshots and prunes sync messages', async () => {
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
    expect(ctx.vault.pruneSyncMessagesUpToCursor).toHaveBeenCalledTimes(2)
    expect(ctx.vault.pruneSyncMessagesUpToCursor).toHaveBeenCalledWith({
      account: 'acct-1',
      itemId: 'item-1',
      cursor: 10,
    })
    expect(ctx.vault.pruneSyncMessagesUpToCursor).toHaveBeenCalledWith({
      account: 'acct-1',
      itemId: 'item-2',
      cursor: 20,
    })
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('suppresses and logs errors from pruneSyncMessagesUpToCursor without failing the request', async () => {
    const ctx = createContext()
    ctx.vault.pruneSyncMessagesUpToCursor.mockRejectedValue(new Error('DynamoDB connection timeout'))
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
      ],
    }

    const result = await caller.putSnapshots(input)

    expect(result).toEqual({
      success: true,
      persisted: 1,
      total: 1,
    })

    expect(ctx.vault.set).toHaveBeenCalledTimes(1)
    expect(ctx.vault.updateAccountData).toHaveBeenCalledTimes(1)
    expect(ctx.vault.pruneSyncMessagesUpToCursor).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy.mock.calls[0][0]).toContain(
      'Failed to prune sync messages up to cursor 10 for item item-1'
    )
  })
})
