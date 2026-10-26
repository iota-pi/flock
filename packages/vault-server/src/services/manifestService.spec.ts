import { fetchManifest, fetchSnapshotsByIds, toFetchedItem } from './manifestService'
import type { VaultItem, VaultDriver } from '../drivers/vaultDriver'
import type { ItemId } from '@vault/shared'

function createMockVault(): VaultDriver {
  return {
    fetchManifest: vi.fn(),
    fetchByIds: vi.fn(),
  } as unknown as VaultDriver
}

describe('manifestService.fetchManifest', () => {
  it('returns typed ManifestEntry objects for items', async () => {
    const vault = createMockVault()
    vi.mocked(vault.fetchManifest).mockResolvedValue([
      { itemId: 'item-1' as ItemId, modifiedAt: 1000 },
      { itemId: 'item-2' as ItemId, modifiedAt: 2000, isDeleted: true },
      { itemId: 'item-3' as ItemId, modifiedAt: 3000 },
    ])

    const result = await fetchManifest({ vault }, { account: 'test-account' })

    expect(vault.fetchManifest).toHaveBeenCalledWith({ account: 'test-account' })
    expect(result.manifest).toEqual([
      { itemId: 'item-1', modifiedAt: 1000 },
      { itemId: 'item-2', modifiedAt: 2000, isDeleted: true },
      { itemId: 'item-3', modifiedAt: 3000 },
    ])
    expect(typeof result.serverTime).toBe('number')
  })

  it('handles empty manifest', async () => {
    const vault = createMockVault()
    vi.mocked(vault.fetchManifest).mockResolvedValue([])

    const result = await fetchManifest({ vault }, { account: 'test-account' })

    expect(result.manifest).toEqual([])
    expect(typeof result.serverTime).toBe('number')
  })
})

describe('manifestService.fetchSnapshotsByIds', () => {
  it('fetches items by ids from vault', async () => {
    const vault = createMockVault()
    const mockItems: VaultItem[] = [
      { account: 'test-account', item: 'item-1', metadata: { iv: 'iv', modified: 1000 }, version: 3 },
    ]
    vi.mocked(vault.fetchByIds).mockResolvedValue(mockItems)

    const result = await fetchSnapshotsByIds({ vault }, { account: 'test-account', itemIds: ['item-1' as ItemId] })

    expect(vault.fetchByIds).toHaveBeenCalledWith({ account: 'test-account', itemIds: ['item-1'] })
    expect(result.items).toEqual([{ item: 'item-1', metadata: { iv: 'iv', modified: 1000 }, version: 3 }])
    expect(typeof result.serverTime).toBe('number')
  })
})

describe('manifestService.toFetchedItem', () => {
  it('sends a snapshot row without its legacy cipher', () => {
    const record: VaultItem = {
      account: 'acct',
      item: 'item-1',
      metadata: { iv: '', modified: 1 },
      cipher: 'legacy',
      snapshot: { iv: 'iv', cipher: 'c2FtcGxl', kver: '2' },
      version: 4,
    }

    expect(toFetchedItem(record)).toEqual({
      item: 'item-1',
      metadata: { iv: '', modified: 1 },
      snapshot: { iv: 'iv', cipher: 'c2FtcGxl', kver: '2' },
      version: 4,
    })
  })

  it('sends a snapshot without a ciphertext with an empty one, so it fails to decrypt', () => {
    const record: VaultItem = {
      account: 'acct',
      item: 'item-1',
      metadata: { iv: '', modified: 1 },
      snapshot: { iv: 'iv' },
    }

    expect(toFetchedItem(record)).toMatchObject({ snapshot: { iv: 'iv', cipher: '' } })
  })

  it('passes legacy metadata through whole', () => {
    const metadata = { iv: 'iv', modified: 1, kver: '1' }
    const record = { account: 'acct', item: 'item-1', metadata, cipher: 'legacy' } as VaultItem

    expect(toFetchedItem(record)).toEqual({ item: 'item-1', metadata, cipher: 'legacy', version: undefined })
  })

  it('sends a tombstone with neither payload', () => {
    const record: VaultItem = { account: 'acct', item: 'item-1', metadata: { iv: '', modified: 1, deleted: true } }

    expect(toFetchedItem(record)).toEqual({
      item: 'item-1',
      metadata: { iv: '', modified: 1, deleted: true },
      version: undefined,
    })
  })
})
