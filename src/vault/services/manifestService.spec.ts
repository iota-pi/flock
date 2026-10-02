import { fetchManifest, fetchSnapshotsByIds } from './manifestService'
import type BaseDriver from '../drivers/base'
import type { VaultItem } from '../drivers/base'
import type { ItemId } from 'src/shared/schemas/items'

function createMockVault(): BaseDriver {
  return {
    fetchManifest: vi.fn(),
    fetchByIds: vi.fn(),
  } as unknown as BaseDriver
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
      { account: 'test-account', item: 'item-1', metadata: { type: 'person', iv: 'iv', modified: 1000 } },
    ]
    vi.mocked(vault.fetchByIds).mockResolvedValue(mockItems)

    const result = await fetchSnapshotsByIds({ vault }, { account: 'test-account', itemIds: ['item-1' as ItemId] })

    expect(vault.fetchByIds).toHaveBeenCalledWith({ account: 'test-account', itemIds: ['item-1'] })
    expect(result.items).toEqual(mockItems)
    expect(typeof result.serverTime).toBe('number')
  })
})
