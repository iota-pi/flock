import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mutateDeleteItems, mutateStoreItems, mutateSetMetadata } from './mutations'
import { queryClient, queryKeys } from './client'
import { getBlankPerson, Item, GroupItem } from '../state/items'
import * as VaultAPI from './VaultAPI'
import * as Vault from './Vault'

// Mock VaultAPI
vi.mock('./VaultAPI', () => ({
  vaultPut: vi.fn(),
  vaultPutMany: vi.fn(),
  vaultDelete: vi.fn(),
  vaultDeleteMany: vi.fn(),
  vaultSetMetadata: vi.fn(),
  vaultGetMetadata: vi.fn(),
  vaultFetchMany: vi.fn(),
}))

// Mock Vault (for encryption/getVaultModule dynamic import resolution)
vi.mock('./Vault', () => ({
  encryptObject: vi.fn().mockResolvedValue({ cipher: 'cipher', iv: 'iv' }),
  decryptObject: vi.fn(),
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn().mockReturnValue('test-account'),
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

    it('resolves version conflicts by merging and retrying', async () => {
      const item = getBlankPerson()
      item.version = 1
      item.name = 'Base'

      const baseItem = { ...item }
      // Cache has base
      queryClient.setQueryData(queryKeys.items, [baseItem])

      // "Yours" - we change description
      const yours = { ...item, description: 'Yours' }

      // "Theirs" - server has name change (version is higher)
      const theirs = { ...item, name: 'Theirs', version: 2 };

      // Mock Put failure once, then success
      (VaultAPI.vaultPut as any)
        .mockRejectedValueOnce(new Error('Version conflict: The item has been modified by another client.'))
        .mockResolvedValue(undefined)

      // Mock Fetch Many to return "Theirs" (encrypted)
      // @ts-ignore
      VaultAPI.vaultFetchMany.mockResolvedValue([
        {
          item: item.id,
          cipher: 'cipher-theirs',
          metadata: { iv: 'iv-theirs', type: 'person', modified: 2, version: 2 }
        }
      ])

      // Mock Decrypt to return "Theirs" when asked
      // @ts-ignore
      Vault.decryptObject.mockImplementation(async ({ cipher }) => {
        if (cipher === 'cipher-theirs') return theirs
        return {} // shouldn't happen
      })

      const result = await mutateStoreItems(yours)

      // Expect merge: Name from Theirs (since Yours didn't change it), Description from Yours
      expect(result[0].name).toBe('Theirs')
      expect(result[0].description).toBe('Yours')
      // Version should be Theirs + 1
      expect(result[0].version).toBe(3)

      expect(VaultAPI.vaultPut).toHaveBeenCalledTimes(2)
      expect(VaultAPI.vaultFetchMany).toHaveBeenCalledWith({ ids: [item.id] })
    })
  })
  describe('mutateDeleteItems', () => {
    it('updates group version when deleting a member', async () => {
      const gItem = { ...getBlankPerson(), id: 'g1', type: 'group', members: ['p1'], version: 1 } as unknown as GroupItem
      const pItem = { ...getBlankPerson(), id: 'p1' }

      // Cache has items
      queryClient.setQueryData(queryKeys.items, [gItem, pItem])

      // Mock Fetch Many (called by fetchItems to get fresh group state)
      // @ts-ignore
      VaultAPI.vaultFetchMany.mockResolvedValue([
        {
          item: gItem.id,
          cipher: 'cipher-group',
          metadata: { iv: 'iv-group', type: 'group', modified: 1, version: 1 }
        }
      ])

      // Mock Decrypt
      // @ts-ignore
      Vault.decryptObject.mockImplementation(async ({ cipher }) => {
        if (cipher === 'cipher-group') return gItem
        return {}
      })

      await mutateDeleteItems('p1')

      // Verify Group Update
      expect(VaultAPI.vaultPutMany).toHaveBeenCalledWith(expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            item: 'g1',
            metadata: expect.objectContaining({
              version: 2
            })
          })
        ])
      }))

      // Verify Item Delete
      expect(VaultAPI.vaultDelete).toHaveBeenCalledWith({ item: 'p1' })
    })
  })

  describe('mutateSetMetadata', () => {
    it('resolves version conflict by merging', async () => {
      const initialMetadata = { prayerGoal: 10, version: 1 }
      queryClient.setQueryData(queryKeys.metadata, initialMetadata)

      // Mock Set Metadata Conflict sequence
      // @ts-ignore
      const setMetadataSpy = vi.spyOn(VaultAPI, 'vaultSetMetadata')
        .mockRejectedValueOnce(new Error('ConditionalCheckFailed'))
        .mockResolvedValue(undefined)

      // Mock Get Metadata (Server state)
      const serverMetadata = { prayerGoal: 10, version: 2, completedMigrations: ['mig1'] }
      // @ts-ignore
      const getMetadataSpy = vi.spyOn(VaultAPI, 'vaultGetMetadata')
        .mockResolvedValue(serverMetadata)

      await mutateSetMetadata(prev => ({ ...prev, prayerGoal: 20 }))

      // Verify Retry call
      expect(setMetadataSpy).toHaveBeenCalledTimes(2)

      // First call: version 2
      expect(setMetadataSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({ version: 2 }))

      // Second call: version 3 (merged)
      expect(setMetadataSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({ version: 3 }))

      // Verify Cache
      const cached = queryClient.getQueryData(queryKeys.metadata)
      expect(cached).toEqual({
        prayerGoal: 20,
        version: 3,
        completedMigrations: ['mig1']
      })
    })
  })
})
