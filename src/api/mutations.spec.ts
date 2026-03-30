import { vi, describe, it, expect, beforeEach } from 'vitest'
import { mutateDeleteItems, mutateStoreItems, mutateSetMetadata } from './mutations'
import { queryClient, queryKeys } from './queryClient'
import { getBlankGroup, getBlankPerson, Item, GroupItem } from '../state/items'
import * as VaultAPI from './VaultAPI'
import * as Vault from './Vault'

// Mock VaultAPI
vi.mock('./VaultAPI', async importOriginal => {
  const actual = await importOriginal<typeof import('./VaultAPI')>()
  return {
    ...actual,
    vaultPut: vi.fn(),
    vaultPutMany: vi.fn(),
    vaultSetMetadata: vi.fn(),
    vaultGetMetadata: vi.fn(),
    vaultFetchMany: vi.fn(),
  }
})

// Mock Vault (for encryption/getVaultModule dynamic import resolution)
vi.mock('./Vault', () => ({
  encryptObject: vi.fn().mockResolvedValue({ cipher: 'cipher', iv: 'iv' }),
  encryptObjectAsAutomerge: vi.fn().mockResolvedValue({
    encryptedAutomergeDoc: 'automerge-doc',
    versionId: 'version-new',
  }),
  decryptObject: vi.fn(),
}))

vi.mock('./util', () => ({
  getAccountId: vi.fn().mockReturnValue('test-account'),
}))

vi.mock('./trpcClient', () => ({
  trpcClient: {
    items: {
      resolveBranchConflict: {
        mutate: vi.fn().mockResolvedValue({ success: true, resolvedCount: 1 }),
      },
    },
  },
}))

vi.mock('./axios', () => ({
  checkAxios: vi.fn().mockReturnValue(true),
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
        branches: expect.any(Array),
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
        branches: expect.any(Array),
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
        branches: expect.any(Array),
      }))
    })

    it('resolves bubbled conflicts through branch resolution flow', async () => {
      const item = getBlankPerson()
      item.version = 1
      item.name = 'Base'

      const baseItem = { ...item }
      // Cache has base
      queryClient.setQueryData(queryKeys.items, [baseItem])

      // "Yours" - we change description
      const yours = { ...item, description: 'Yours' }

      // Mock put failure once.
      vi.mocked(VaultAPI.vaultPut)
        .mockRejectedValueOnce(new Error('Version conflict: The item has been modified by another client.'))

      // Mock Fetch Many to return current branching state.
      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({ items: [
        {
          item: item.id,
          branches: [
            {
              encryptedAutomergeDoc: 'server-branch-doc',
              versionId: 'server-v2',
              parentIds: ['server-v1'],
            },
          ],
          metadata: { iv: '', type: 'person', modified: 2 }
        }
      ], serverTime: Date.now() })

      const result = await mutateStoreItems(yours)

      // Conflict is resolved via branch compaction endpoint; local optimistic state is retained.
      expect(result[0].description).toBe('Yours')
      expect(VaultAPI.vaultPut).toHaveBeenCalledTimes(1)
      expect(VaultAPI.vaultFetchMany).toHaveBeenCalled()
    })

    it('does not throw when server emits a branch conflict on equivalent payload', async () => {
      const item = getBlankPerson()
      item.version = 1
      item.name = 'Updated Name'

      queryClient.setQueryData(queryKeys.items, [{ ...item }])

      const local = { ...item }
      vi.mocked(VaultAPI.vaultPut)
        .mockRejectedValueOnce(new Error('Version conflict: The item has been modified by another client.'))

      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({ items: [
        {
          item: item.id,
          branches: [
            {
              encryptedAutomergeDoc: 'server-branch-doc',
              versionId: 'server-v2',
              parentIds: ['server-v1'],
            },
          ],
          metadata: { iv: '', type: 'person', modified: 2 },
        },
      ], serverTime: Date.now() })

      const result = await mutateStoreItems(local)

      expect(VaultAPI.vaultPut).toHaveBeenCalledTimes(1)
      expect(result[0].name).toBe(local.name)
      expect(VaultAPI.vaultFetchMany).toHaveBeenCalled()
    })

    it('handles repeated conflicts by routing to branch conflict resolver', async () => {
      const item = getBlankPerson()
      item.version = 1

      // First update succeeds and records latest successful version (2).
      queryClient.setQueryData(queryKeys.items, [{ ...item }])
      vi.mocked(VaultAPI.vaultPut).mockResolvedValueOnce(undefined)
      await mutateStoreItems({ ...item, name: 'newer-write' })

      // Simulate stale cache producing an older write attempt.
      queryClient.setQueryData(queryKeys.items, [{ ...item }])
      vi.mocked(VaultAPI.vaultPut).mockRejectedValueOnce(
        new Error('Version conflict: The item has been modified by another client.'),
      )
      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({
        items: [
          {
            item: item.id,
            branches: [
              {
                encryptedAutomergeDoc: 'server-branch-doc',
                versionId: 'server-v2',
                parentIds: ['server-v1'],
              },
            ],
            metadata: { iv: '', type: 'person', modified: 2 },
          },
        ],
        serverTime: Date.now(),
      })

      await expect(mutateStoreItems({ ...item, description: 'stale-write' })).resolves.toBeDefined()
      expect(VaultAPI.vaultFetchMany).toHaveBeenCalled()
      expect(VaultAPI.vaultPut).toHaveBeenCalledTimes(2)
    })

    it('uses transaction conflict ids returned by vaultPutMany', async () => {
      const first = getBlankPerson()
      first.id = 'first'
      first.version = 1

      const second = getBlankPerson()
      second.id = 'second'
      second.version = 1
      second.name = 'Updated'

      queryClient.setQueryData(queryKeys.items, [{ ...first }, { ...second }])

      vi.mocked(VaultAPI.vaultPutMany)
        .mockRejectedValueOnce(new VaultAPI.VaultVersionConflictError([second.id]))

      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({ items: [
        {
          item: second.id,
          branches: [
            {
              encryptedAutomergeDoc: 'server-branch-doc',
              versionId: 'server-v2',
              parentIds: ['server-v1'],
            },
          ],
          metadata: { iv: '', type: 'person', modified: 2 },
        },
      ], serverTime: Date.now() })

      const result = await mutateStoreItems([first, second])

      expect(VaultAPI.vaultFetchMany).toHaveBeenCalled()
      expect(result.find(item => item.id === second.id)?.version).toBeDefined()
    })
  })

  describe('mutateDeleteItems', () => {
    it('updates group version when deleting a member', async () => {
      const gItem = {
        ...getBlankGroup('g1', false),
        members: ['p1'],
        version: 1,
      } as GroupItem
      const pItem = { ...getBlankPerson(), id: 'p1' }

      // Cache has items
      queryClient.setQueryData(queryKeys.items, [gItem, pItem])

      // Mock Fetch Many (called by fetchItems to get fresh group state)
      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({ items: [
        {
          item: gItem.id,
          cipher: 'cipher-group',
          metadata: { iv: 'iv-group', type: 'group', modified: 1 }
        },
        {
          item: pItem.id,
          cipher: 'cipher-person',
          metadata: { iv: 'iv-person', type: 'person', modified: 1 }
        }
      ], serverTime: Date.now() })

      // Mock Decrypt
      vi.mocked(Vault.decryptObject).mockImplementation(async ({ cipher }) => {
        if (cipher === 'cipher-group') return gItem
        if (cipher === 'cipher-person') return pItem
        return {}
      })

      // Mock Metadata
      vi.mocked(VaultAPI.vaultGetMetadata).mockResolvedValue({})

      await mutateDeleteItems('p1')

      // Verify Group Update
      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        item: 'g1',
        metadata: expect.objectContaining({
          version: 2
        })
      }))

      // Verify Item Tombstone save through regular put flow
      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        item: 'p1',
        branches: [],
        metadata: expect.objectContaining({
          iv: '',
          deleted: true,
          version: 1,
        }),
      }))
    })

    it('creates tombstones for multiple items without hard delete endpoints', async () => {
      const item1 = { ...getBlankPerson(), id: 'p1', version: 1 }
      const item2 = { ...getBlankPerson(), id: 'p2', version: 1 }

      queryClient.setQueryData(queryKeys.items, [item1, item2])

      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({ items: [
        {
          item: item1.id,
          cipher: 'cipher1',
          metadata: { iv: 'iv1', type: 'person', modified: 1 }
        },
        {
          item: item2.id,
          cipher: 'cipher2',
          metadata: { iv: 'iv2', type: 'person', modified: 1 }
        }
      ], serverTime: Date.now() })

      vi.mocked(Vault.decryptObject).mockImplementation(async ({ cipher }) => {
        if (cipher === 'cipher1') return item1
        if (cipher === 'cipher2') return item2
        return {}
      })

      vi.mocked(VaultAPI.vaultGetMetadata).mockResolvedValue({})

      await mutateDeleteItems(['p1', 'p2'])

      // Verify tombstones are created via putMany (batch deletion)
      expect(VaultAPI.vaultPutMany).toHaveBeenCalled()
      const putManyCall = vi.mocked(VaultAPI.vaultPutMany).mock.calls[0][0]
      const tombstones = putManyCall.items.filter((item: any) => item.metadata?.deleted === true)
      expect(tombstones).toHaveLength(2)
      expect(tombstones.every((item: any) => Array.isArray(item.branches) && item.metadata?.iv === '')).toBe(true)
    })

    it('soft-deletes without using deprecated delete/deleteMany endpoints', async () => {
      const item = { ...getBlankPerson(), id: 'p1', version: 1 }

      queryClient.setQueryData(queryKeys.items, [item])

      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({ items: [
        {
          item: item.id,
          cipher: 'cipher1',
          metadata: { iv: 'iv1', type: 'person', modified: 1 }
        }
      ], serverTime: Date.now() })

      vi.mocked(Vault.decryptObject).mockResolvedValue(item)
      vi.mocked(VaultAPI.vaultGetMetadata).mockResolvedValue({})

      await mutateDeleteItems('p1')

      // Verify deletion created a tombstone via put (not using deprecated delete endpoint)
      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        item: 'p1',
        branches: [],
        metadata: expect.objectContaining({
          iv: '',
          deleted: true,
        }),
      }))
    })

    it('increments version when creating tombstones', async () => {
      const item = { ...getBlankPerson(), id: 'p1', version: 5 }

      queryClient.setQueryData(queryKeys.items, [item])

      vi.mocked(VaultAPI.vaultFetchMany).mockResolvedValue({ items: [
        {
          item: item.id,
          cipher: 'cipher1',
          metadata: { iv: 'iv1', type: 'person', modified: 1 }
        }
      ], serverTime: Date.now() })

      vi.mocked(Vault.decryptObject).mockResolvedValue(item)
      vi.mocked(VaultAPI.vaultGetMetadata).mockResolvedValue({})

      await mutateDeleteItems('p1')

      // Verify version incremented to 6
      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        item: 'p1',
        branches: [],
        metadata: expect.objectContaining({
          iv: '',
          deleted: true,
          version: 6,
        }),
      }))
    })
  })

  describe('mutateSetMetadata', () => {
    it('resolves version conflict by merging', async () => {
      const initialMetadata = { prayerGoal: 10, version: 1 }
      queryClient.setQueryData(queryKeys.metadata, initialMetadata)

      // Mock Set Metadata Conflict sequence
      // Mock Set Metadata Conflict sequence
      const setMetadataSpy = vi.spyOn(VaultAPI, 'vaultSetMetadata')
        .mockRejectedValueOnce(new Error('ConditionalCheckFailed'))
        .mockResolvedValue(undefined)

      // Mock Get Metadata (Server state)
      const serverMetadata = { prayerGoal: 10, version: 2, completedMigrations: ['mig1'] }
      vi.spyOn(VaultAPI, 'vaultGetMetadata').mockResolvedValue(serverMetadata)

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
