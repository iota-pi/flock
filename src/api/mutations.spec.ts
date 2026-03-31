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
    it('stores new items using branch payloads', async () => {
      const item = getBlankPerson()

      const result = await mutateStoreItems(item)

      expect(result[0].id).toBe(item.id)

      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        branches: expect.any(Array),
      }))
    })

    it('updates existing items without linear version increments', async () => {
      const item = getBlankPerson()
      const itemV1 = { ...item, id: item.id, name: 'Original' }

      // Populate cache with V1
      queryClient.setQueryData(queryKeys.items, [itemV1])

      const itemUpdate = { ...item, name: 'Updated' }
      const result = await mutateStoreItems(itemUpdate)

      expect(result[0].name).toBe('Updated')

      // Verify Cache
      const cached = queryClient.getQueryData<Item[]>(queryKeys.items)
      expect(cached).toBeDefined()
      expect(cached![0].name).toBe('Updated')

      // Verify API
      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        branches: expect.any(Array),
      }))
    })

    it('handles legacy items in cache', async () => {
      const item = getBlankPerson()
      const legacyItem = { ...item } as any

      queryClient.setQueryData(queryKeys.items, [legacyItem])

      const itemUpdate = { ...item }
      const result = await mutateStoreItems(itemUpdate)

      expect(result[0].id).toBe(item.id)

      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        branches: expect.any(Array),
      }))
    })

    it('resolves bubbled conflicts through branch resolution flow', async () => {
      const item = getBlankPerson()
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

      const second = getBlankPerson()
      second.id = 'second'
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
      expect(result.find(item => item.id === second.id)?.name).toBe('Updated')
    })
  })

  describe('mutateDeleteItems', () => {
    it('updates group and creates tombstone when deleting a member', async () => {
      const gItem = {
        ...getBlankGroup('g1', false),
        members: ['p1'],
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
          deleted: undefined,
        })
      }))

      // Verify Item Tombstone save through regular put flow
      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        item: 'p1',
        branches: expect.arrayContaining([
          expect.objectContaining({
            encryptedAutomergeDoc: expect.any(String),
            versionId: expect.any(String),
          }),
        ]),
        metadata: expect.objectContaining({
          iv: '',
          deleted: true,
        }),
      }))
    })

    it('creates tombstones for multiple items without hard delete endpoints', async () => {
      const item1 = { ...getBlankPerson(), id: 'p1' }
      const item2 = { ...getBlankPerson(), id: 'p2' }

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
      const item = { ...getBlankPerson(), id: 'p1' }

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
        branches: expect.arrayContaining([
          expect.objectContaining({
            encryptedAutomergeDoc: expect.any(String),
            versionId: expect.any(String),
          }),
        ]),
        metadata: expect.objectContaining({
          iv: '',
          deleted: true,
        }),
      }))
    })

    it('creates tombstones without linear version metadata', async () => {
      const item = { ...getBlankPerson(), id: 'p1' }

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

      expect(VaultAPI.vaultPut).toHaveBeenCalledWith(expect.objectContaining({
        item: 'p1',
        branches: expect.arrayContaining([
          expect.objectContaining({
            encryptedAutomergeDoc: expect.any(String),
            versionId: expect.any(String),
          }),
        ]),
        metadata: expect.objectContaining({
          iv: '',
          deleted: true,
        }),
      }))
    })
  })

  describe('mutateSetMetadata', () => {
    it('stores metadata as branch payloads', async () => {
      const initialMetadata = { prayerGoal: 10 }
      queryClient.setQueryData(queryKeys.metadata, initialMetadata)

      const setMetadataSpy = vi.spyOn(VaultAPI, 'vaultSetMetadata').mockResolvedValue(undefined)
      vi.spyOn(VaultAPI, 'vaultGetMetadata').mockResolvedValue({})

      await mutateSetMetadata(prev => ({ ...prev, prayerGoal: 20 }))

      expect(setMetadataSpy).toHaveBeenCalledTimes(1)
      expect(setMetadataSpy).toHaveBeenCalledWith(expect.objectContaining({
        branches: expect.any(Array),
      }))

      const cached = queryClient.getQueryData(queryKeys.metadata)
      expect(cached).toEqual({
        prayerGoal: 20,
      })
    })
  })
})
