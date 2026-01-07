import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mutateStoreItems } from './mutations'
import { queryClient, queryKeys } from './client'
import { getBlankPerson, Item } from '../state/items'
import * as VaultAPI from './VaultAPI'

// Mock VaultAPI
vi.mock('./VaultAPI', () => ({
  vaultPut: vi.fn(),
  vaultPutMany: vi.fn(),
  vaultDelete: vi.fn(),
  vaultDeleteMany: vi.fn(),
  vaultSetMetadata: vi.fn(),
}))

// Mock Vault (for encryption/getVaultModule dynamic import resolution)
// mutateStoreItems calls `getVaultModule` which does `import('./Vault')`.
// In vitest, vi.mock('./Vault') should handle the dynamic import if the path matches?
// Actually `getVaultModule` imports it. We can mock the module globally.
vi.mock('./Vault', () => ({
  encryptObject: vi.fn().mockResolvedValue({ cipher: 'cipher', iv: 'iv' }),
}))

describe('mutations', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  describe('mutateStoreItems', () => {
    it('initializes version to 1 for new items', async () => {
      const item = getBlankPerson()
      // item has version: 1 by default, but assume it's new (not in cache)

      const result = await mutateStoreItems(item)

      expect(result[0].version).toBe(1)

      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          version: 1,
        }),
      }))
    })

    it('increments version for existing items', async () => {
      const item = getBlankPerson()
      item.version = 1
      const itemV1 = { ...item, id: item.id }

      // Populate cache with V1
      queryClient.setQueryData(queryKeys.items, [itemV1])

      // Store same item (maybe modified)
      const itemUpdate = { ...item, name: 'Updated' }
      const result = await mutateStoreItems(itemUpdate)

      expect(result[0].version).toBe(2)

      // Verify Cache
      const cached = queryClient.getQueryData<Item[]>(queryKeys.items)
      expect(cached).toBeDefined()
      expect(cached![0].version).toBe(2)

      // Verify API
      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          version: 2,
        }),
      }))
    })

    it('handles legacy items (no version) in cache', async () => {
      const item = getBlankPerson()
      // Simulate legacy item in cache (no version)
      // We need to cast to force no version if typing prevents it,
      // but simpler to just use an object that matches runtime shape.
      const legacyItem = { ...item } as any
      delete legacyItem.version

      queryClient.setQueryData(queryKeys.items, [legacyItem])

      const itemUpdate = { ...item }
      const result = await mutateStoreItems(itemUpdate)

      // undefined version -> treated as 0 -> +1 = 1
      expect(result[0].version).toBe(1)

      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          version: 1,
        }),
      }))
    })
  })
})
