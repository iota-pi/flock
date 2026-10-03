import { persistSnapshots } from './snapshotService'
import type { VaultDriver } from '../drivers/base'
import type { ItemId } from 'src/shared/schemas/items'

function createMockVault(): VaultDriver {
  return {
    set: vi.fn(async () => undefined),
    updateAccountData: vi.fn(async () => undefined),
  } as unknown as VaultDriver
}

describe('snapshotService.persistSnapshots', () => {
  it('transforms input snapshots to VaultItems, calls vault.set for each, and updates account metadata', async () => {
    const vault = createMockVault()
    const now = () => 1700000000000

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1' as ItemId,
          type: 'person',
          modified: 12345,
          snapshot: {
            iv: 'iv-1',
            cipher: 'cipher-1',
          },
          snapshotCursor: 10,
        },
        {
          itemId: 'item-2' as ItemId,
          type: 'group',
          modified: 12346,
          deleted: true,
          snapshot: {
            iv: 'iv-2',
            cipher: 'cipher-2',
            kver: 'k2',
          },
          snapshotCursor: 25,
        },
      ],
    }

    const result = await persistSnapshots(vault, input, { now })

    expect(result).toEqual({
      success: true,
      persisted: 2,
      total: 2,
      results: [
        { itemId: 'item-1', version: 1 },
        { itemId: 'item-2', version: 1 },
      ],
    })

    expect(vault.set).toHaveBeenCalledTimes(2)
    expect(vault.set).toHaveBeenNthCalledWith(1, {
      account: 'acct-1',
      item: 'item-1',
      metadata: {
        type: 'person',
        iv: '',
        modified: 12345,
      },
      snapshot: {
        iv: 'iv-1',
        cipher: 'cipher-1',
      },
    })
    expect(vault.set).toHaveBeenNthCalledWith(2, {
      account: 'acct-1',
      item: 'item-2',
      metadata: {
        type: 'group',
        iv: '',
        modified: 12346,
        deleted: true,
      },
      snapshot: {
        iv: 'iv-2',
        cipher: 'cipher-2',
        kver: 'k2',
      },
    })

    expect(vault.updateAccountData).toHaveBeenCalledTimes(1)
    expect(vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      lastSnapshotCursor: 25,
      lastSnapshotAt: 1700000000000,
    })
  })

  it('handles partial failures, logs errors, and updates cursor with max among succeeded snapshots', async () => {
    const vault = createMockVault()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    ;(vault.set as any)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Write failed'))

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1' as ItemId,
          type: 'topic',
          modified: 100,
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
          snapshotCursor: 50,
        },
        {
          itemId: 'item-2' as ItemId,
          type: 'topic',
          modified: 200,
          snapshot: { iv: 'iv-2', cipher: 'c-2' },
          snapshotCursor: 90,
        },
      ],
    }

    const result = await persistSnapshots(vault, input)

    expect(result).toEqual({
      success: false,
      persisted: 1,
      total: 2,
      results: [
        { itemId: 'item-1', version: 1 },
      ],
    })

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to persist snapshot for item item-2'),
      expect.any(Error)
    )

    expect(vault.updateAccountData).toHaveBeenCalledWith({
      account: 'acct-1',
      lastSnapshotCursor: 50,
      lastSnapshotAt: expect.any(Number),
    })

    consoleErrorSpy.mockRestore()
  })

  it('does not update account data when all writes fail', async () => {
    const vault = createMockVault()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    ;(vault.set as any).mockRejectedValue(new Error('DynamoDB down'))

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1' as ItemId,
          type: 'person',
          modified: 100,
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
          snapshotCursor: 15,
        },
      ],
    }

    const result = await persistSnapshots(vault, input)

    expect(result).toEqual({
      success: false,
      persisted: 0,
      total: 1,
      results: [],
    })

    expect(vault.updateAccountData).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('handles empty snapshots list', async () => {
    const vault = createMockVault()

    const input = {
      account: 'acct-1',
      snapshots: [],
    }

    const result = await persistSnapshots(vault, input)

    expect(result).toEqual({
      success: true,
      persisted: 0,
      total: 0,
      results: [],
    })

    expect(vault.set).not.toHaveBeenCalled()
    expect(vault.updateAccountData).not.toHaveBeenCalled()
  })
})
