import { persistSnapshots, type StorageAllowance } from './snapshotService'
import type { VaultDriver } from '../drivers/vaultDriver'
import type { ItemId } from '@vault/shared'
import { QuotaExceededError } from '../errors'

function createMockVault(): VaultDriver {
  return {
    set: vi.fn(async () => ({ version: 1, storageDelta: 0 })),
    updateAccountData: vi.fn(async () => undefined),
    addStorageUsage: vi.fn(async () => undefined),
    readLogHead: vi.fn(async () => 7),
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
          modified: 12345,
          snapshot: {
            iv: 'iv-1',
            cipher: 'cipher-1',
          },
          snapshotCursor: 10,
        },
        {
          itemId: 'item-2' as ItemId,
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

    const result = await persistSnapshots(vault, input, ROOM)

    expect(result).toEqual({
      success: true,
      persisted: 2,
      total: 2,
      results: [
        { itemId: 'item-1', version: 1 },
        { itemId: 'item-2', version: 1 },
      ],
      logSeq: 7,
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
          modified: 500,
          deleted: true,
          snapshotCursor: 10,
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
          modified: 100,
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
          snapshotCursor: 50,
        },
        {
          itemId: 'item-2' as ItemId,
          modified: 200,
          snapshot: { iv: 'iv-2', cipher: 'c-2' },
          snapshotCursor: 90,
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
      logSeq: 7,
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
          modified: 100,
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
          snapshotCursor: 15,
        },
      ],
    }

    const result = await persistSnapshots(vault, input, ROOM)

    expect(result).toEqual({
      success: false,
      persisted: 0,
      total: 1,
      results: [],
      logSeq: 7,
    })

    expect(vault.updateAccountData).not.toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('reads the log head only after every write has finished', async () => {
    const vault = createMockVault()
    let writesInProgress = 0
    vi.mocked(vault.set).mockImplementation(async () => {
      writesInProgress += 1
      await new Promise(resolve => setTimeout(resolve, 5))
      writesInProgress -= 1
      return { version: 2, storageDelta: 0 }
    })
    vi.mocked(vault.readLogHead).mockImplementation(async () => {
      expect(writesInProgress).toBe(0)
      return 12
    })

    const snapshot = { iv: 'iv', cipher: 'cipher' }
    const result = await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [
        { itemId: 'item-1' as ItemId, modified: 1, snapshot, snapshotCursor: 0 },
        { itemId: 'item-2' as ItemId, modified: 2, snapshot, snapshotCursor: 0 },
      ],
    }, ROOM)

    expect(vault.readLogHead).toHaveBeenCalledWith({ account: 'acct-1' })
    expect(result.logSeq).toBe(12)
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
      logSeq: 7,
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
        { itemId: 'item-1' as ItemId, modified: 1, snapshot, snapshotCursor: 0 },
        { itemId: 'item-2' as ItemId, modified: 2, snapshot, snapshotCursor: 0 },
      ],
    }, ROOM)

    expect(vault.addStorageUsage).toHaveBeenCalledTimes(1)
    expect(vault.addStorageUsage).toHaveBeenCalledWith({ account: 'acct-1', bytes: 200 })
  })

  it('leaves usage alone when nothing changed size', async () => {
    const vault = createMockVault()

    await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [{ itemId: 'item-1' as ItemId, modified: 1, snapshot, snapshotCursor: 0 }],
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
        { itemId: 'item-1' as ItemId, modified: 1, snapshot, snapshotCursor: 0 },
        { itemId: 'item-2' as ItemId, modified: 2, snapshot, snapshotCursor: 0 },
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
        { itemId: 'item-1' as ItemId, modified: 1, deleted: true, snapshotCursor: 0 },
        { itemId: 'item-2' as ItemId, modified: 2, snapshot, snapshotCursor: 0 },
      ],
    }, full)).rejects.toBeInstanceOf(QuotaExceededError)

    expect(vault.set).not.toHaveBeenCalled()
  })

  it('still accepts deletions once the account is at its quota', async () => {
    const vault = createMockVault()

    const result = await persistSnapshots(vault, {
      account: 'acct-1',
      snapshots: [{ itemId: 'item-1' as ItemId, modified: 1, deleted: true, snapshotCursor: 0 }],
    }, full)

    expect(result.success).toBe(true)
  })
})
