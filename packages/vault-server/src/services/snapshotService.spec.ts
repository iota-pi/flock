import { persistSnapshots, type StorageAllowance } from './snapshotService'
import type { VaultDriver } from '../drivers/vaultDriver'
import type { ItemId } from '@vault/shared'
import { QuotaExceededError } from '../errors'

function createMockVault(): VaultDriver {
  return {
    set: vi.fn(async () => ({ version: 1, storageDelta: 0 })),
    updateAccountData: vi.fn(async () => undefined),
    addStorageUsage: vi.fn(async () => undefined),
  } as unknown as VaultDriver
}

/** An account well under its quota */
const ROOM: StorageAllowance = { usedBytes: 0, quotaBytes: 1000 }

describe('snapshotService.persistSnapshots', () => {
  it('transforms input snapshots to VaultItems, calls vault.set for each', async () => {
    const vault = createMockVault()

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1' as ItemId,
          snapshot: {
            iv: 'iv-1',
            cipher: 'cipher-1',
          },
        },
        {
          itemId: 'item-2' as ItemId,
          deleted: true,
          snapshot: {
            iv: 'iv-2',
            cipher: 'cipher-2',
            kver: 'k2',
          },
        },
      ],
    }

    const result = await persistSnapshots(vault, input, ROOM)

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
        iv: '',
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
        iv: '',
        deleted: true,
      },
      snapshot: {
        iv: 'iv-2',
        cipher: 'cipher-2',
        kver: 'k2',
      },
    })
  })

  it('persists a payload-less tombstone without a snapshot key', async () => {
    const vault = createMockVault()
    ;(vault.set as any).mockResolvedValueOnce({ version: 7, storageDelta: 0 })

    const result = await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1' as ItemId,
          deleted: true,
        },
      ],
    }, ROOM)

    expect(result.results).toEqual([{ itemId: 'item-1', version: 7 }])
    const item = (vault.set as any).mock.calls[0][0]
    expect('snapshot' in item).toBe(false)
    expect(item.metadata.deleted).toBe(true)
  })

  it('handles partial failures and logs errors', async () => {
    const vault = createMockVault()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    ;(vault.set as any)
      .mockResolvedValueOnce({ version: 1 })
      .mockRejectedValueOnce(new Error('Write failed'))

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1' as ItemId,
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
        },
        {
          itemId: 'item-2' as ItemId,
          snapshot: { iv: 'iv-2', cipher: 'c-2' },
        },
      ],
    }

    const result = await persistSnapshots(vault, input, ROOM)

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

    consoleErrorSpy.mockRestore()
  })

  it('does not touch account data when all writes fail', async () => {
    const vault = createMockVault()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    ;(vault.set as any).mockRejectedValue(new Error('DynamoDB down'))

    const input = {
      account: 'acct-1',
      snapshots: [
        {
          itemId: 'item-1' as ItemId,
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
        },
      ],
    }

    const result = await persistSnapshots(vault, input, ROOM)

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

    const result = await persistSnapshots(vault, input, ROOM)

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

describe('snapshotService.persistSnapshots storage quota', () => {
  const snapshot = { iv: 'iv', cipher: 'cipher' }
  const full: StorageAllowance = { usedBytes: 1000, quotaBytes: 1000 }

  it('adds what the writes grew the items by to the account, in one write', async () => {
    const vault = createMockVault()
    vi.mocked(vault.set)
      .mockResolvedValueOnce({ version: 1, storageDelta: 300 })
      .mockResolvedValueOnce({ version: 4, storageDelta: -100 })

    await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [
        { itemId: 'item-1' as ItemId, snapshot },
        { itemId: 'item-2' as ItemId, snapshot },
      ],
    }, ROOM)

    expect(vault.addStorageUsage).toHaveBeenCalledTimes(1)
    expect(vault.addStorageUsage).toHaveBeenCalledWith({ account: 'acct-1', bytes: 200 })
  })

  it('leaves usage alone when nothing changed size', async () => {
    const vault = createMockVault()

    await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [{ itemId: 'item-1' as ItemId, snapshot }],
    }, ROOM)

    expect(vault.addStorageUsage).not.toHaveBeenCalled()
  })

  it('counts only the writes that succeeded', async () => {
    const vault = createMockVault()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(vault.set)
      .mockResolvedValueOnce({ version: 1, storageDelta: 300 })
      .mockRejectedValueOnce(new Error('write failed'))

    await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [
        { itemId: 'item-1' as ItemId, snapshot },
        { itemId: 'item-2' as ItemId, snapshot },
      ],
    }, ROOM)

    expect(vault.addStorageUsage).toHaveBeenCalledWith({ account: 'acct-1', bytes: 300 })
  })

  // Rejecting single items would make the client quarantine them, though nothing is wrong with them
  it('turns away a whole batch with a snapshot once the account is at its quota', async () => {
    const vault = createMockVault()

    await expect(persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [
        { itemId: 'item-1' as ItemId, deleted: true },
        { itemId: 'item-2' as ItemId, snapshot },
      ],
    }, full)).rejects.toBeInstanceOf(QuotaExceededError)

    expect(vault.set).not.toHaveBeenCalled()
  })

  // Older clients send a tombstone with its full payload, which must not deadlock a full account
  it('writes a deleted snapshot without its payload once the account is at its quota', async () => {
    const vault = createMockVault()
    vi.mocked(vault.set).mockResolvedValueOnce({ version: 3, storageDelta: -500 })

    const result = await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [{ itemId: 'item-1' as ItemId, deleted: true, snapshot, heads: snapshot }],
    }, full)

    expect(result).toEqual({ success: true, persisted: 1, total: 1, results: [{ itemId: 'item-1', version: 3 }] })
    expect(vault.set).toHaveBeenCalledWith({ account: 'acct-1', item: 'item-1', metadata: { iv: '', deleted: true } })
    expect(vault.addStorageUsage).toHaveBeenCalledWith({ account: 'acct-1', bytes: -500 })
  })

  it('turns away a live snapshot at the quota though the batch also deletes with a payload', async () => {
    const vault = createMockVault()

    await expect(persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [
        { itemId: 'item-1' as ItemId, deleted: true, snapshot },
        { itemId: 'item-2' as ItemId, snapshot },
      ],
    }, full)).rejects.toBeInstanceOf(QuotaExceededError)

    expect(vault.set).not.toHaveBeenCalled()
  })

  it('keeps a deleted snapshot payload while the account has room', async () => {
    const vault = createMockVault()

    await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [{ itemId: 'item-1' as ItemId, deleted: true, snapshot }],
    }, ROOM)

    expect(vault.set).toHaveBeenCalledWith(expect.objectContaining({ snapshot }))
  })

  it('still accepts deletions once the account is at its quota', async () => {
    const vault = createMockVault()

    const result = await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [{ itemId: 'item-1' as ItemId, deleted: true }],
    }, full)

    expect(result.success).toBe(true)
  })
})
