import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ManifestHydrator } from './ManifestHydrator'
import type { ItemId } from '../../shared/schemas/items'

const mockDecryptBytes = vi.fn()
const mockDecryptObject = vi.fn()
const mockHasVaultKey = vi.fn().mockReturnValue(true)
const mockWaitForKeyVersion = vi.fn().mockResolvedValue(true)

vi.mock('../../api/vault', () => ({
  decryptBytes: (...args: any[]) => mockDecryptBytes(...args),
  decryptObject: (...args: any[]) => mockDecryptObject(...args),
  hasVaultKey: (...args: any[]) => mockHasVaultKey(...args),
  waitForKeyVersion: (...args: any[]) => mockWaitForKeyVersion(...args),
}))

vi.mock('./utils/decryptWithKeyResolution', () => ({
  decryptWithKeyResolution: async (cryptoResult: any) => {
    return mockDecryptBytes(cryptoResult)
  },
}))

describe('ManifestHydrator', () => {
  let hydrator: ManifestHydrator
  let mockApiClient: any
  let mockDocStore: any
  let mockIndexManager: any
  let mockSnapshotManager: any
  let storeItemsSpy: any
  let onDecryptionFailureSpy: any
  let onItemSnapshotHydratedSpy: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockApiClient = {
      fetchSnapshotsByIds: vi.fn(),
    }
    mockDocStore = {
      hydrateAutomergeDocumentBinary: vi.fn(),
    }
    mockIndexManager = {
      addAutomergeItemIdsToIndex: vi.fn().mockResolvedValue(undefined),
      removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
    }
    mockSnapshotManager = {
      importLastModified: vi.fn().mockResolvedValue(undefined),
      markItemDirty: vi.fn(),
    }
    storeItemsSpy = vi.fn().mockResolvedValue(undefined)
    onDecryptionFailureSpy = vi.fn()
    onItemSnapshotHydratedSpy = vi.fn()

    hydrator = new ManifestHydrator({
      accountId: 'acc-test',
      apiClient: mockApiClient,
      docStore: mockDocStore,
      indexManager: mockIndexManager,
      snapshotManager: mockSnapshotManager,
      storeItems: storeItemsSpy,
      onDecryptionFailure: onDecryptionFailureSpy,
      onItemSnapshotHydrated: onItemSnapshotHydratedSpy,
    })
  })

  describe('hydrateRemoteItem', () => {
    it('returns structured success for active Automerge binary document', async () => {
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockDocStore.hydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: false,
        incomingHeads: ['head-1'],
      })

      const item = {
        item: 'item-binary',
        snapshot: { iv: 'iv-1', cipher: 'c-1' },
      }

      const result = await hydrator.hydrateRemoteItem(
        item as any,
        [['item-binary', 2000]],
        new Set(['item-binary' as ItemId]),
      )

      expect(result).toEqual({
        status: 'success',
        itemId: 'item-binary',
        hydratedId: 'item-binary',
        lastModifiedUpdate: ['item-binary', 2000],
      })
      expect(onItemSnapshotHydratedSpy).toHaveBeenCalledWith('item-binary', ['head-1'])
    })

    it('returns structured success with markDirty when Automerge document has local changes', async () => {
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockDocStore.hydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: true,
        incomingHeads: ['head-1'],
      })

      const item = {
        item: 'item-binary-changes',
        snapshot: { iv: 'iv-1', cipher: 'c-1' },
      }

      const result = await hydrator.hydrateRemoteItem(
        item as any,
        [['item-binary-changes', 2000]],
        new Set(['item-binary-changes' as ItemId]),
      )

      expect(result).toEqual({
        status: 'success',
        itemId: 'item-binary-changes',
        hydratedId: 'item-binary-changes',
        lastModifiedUpdate: undefined,
      })
      expect(mockSnapshotManager.markItemDirty).toHaveBeenCalledWith('item-binary-changes', 2000)
    })

    it('returns structured success for deleted metadata without decryption', async () => {
      const item = {
        item: 'item-deleted-meta',
        metadata: { deleted: true },
      }

      const result = await hydrator.hydrateRemoteItem(
        item as any,
        [['item-deleted-meta', 3000]],
        new Set(),
      )

      expect(result).toEqual({
        status: 'success',
        itemId: 'item-deleted-meta',
        snapshot: { id: 'item-deleted-meta', deleted: true },
        lastModifiedUpdate: ['item-deleted-meta', 3000],
      })
      expect(mockDecryptBytes).not.toHaveBeenCalled()
      expect(mockDecryptObject).not.toHaveBeenCalled()
    })

    it('returns decryption_failure when both binary and legacy decryption fail', async () => {
      mockDecryptBytes.mockResolvedValue(null)

      const item = {
        item: 'item-un-decryptable',
        snapshot: { iv: 'iv-bad', cipher: 'c-bad' },
      }

      const result = await hydrator.hydrateRemoteItem(
        item as any,
        [['item-un-decryptable', 1000]],
        new Set(),
      )

      expect(result.status).toBe('decryption_failure')
      expect(result.itemId).toBe('item-un-decryptable')
      expect((result as any).error.message).toContain('Failed to decrypt')
    })
  })

  describe('fetchAndHydrateRemoteItems', () => {
    it('fetches in batches, hydrates items, and persists results', async () => {
      mockApiClient.fetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-1',
            metadata: { deleted: true },
          },
        ],
      })

      const result = await hydrator.fetchAndHydrateRemoteItems({
        missingIds: ['item-1' as ItemId],
        manifest: [['item-1', 1000]],
        serverTime: 1000,
        knownSet: new Set(),
        tombstoneSet: new Set(),
      })

      expect(result.hasFailures).toBe(false)
      expect(storeItemsSpy).toHaveBeenCalledWith(
        [{ id: 'item-1', deleted: true }],
        { markDirty: false },
      )
      expect(mockSnapshotManager.importLastModified).toHaveBeenCalledWith([['item-1', 1000]])
    })

    it('reports decryption failure to onDecryptionFailure', async () => {
      mockApiClient.fetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-bad',
            snapshot: { iv: 'bad-iv', cipher: 'bad-cipher' },
          },
        ],
      })
      mockDecryptBytes.mockResolvedValue(null)

      const result = await hydrator.fetchAndHydrateRemoteItems({
        missingIds: ['item-bad' as ItemId],
        manifest: [['item-bad', 1000]],
        serverTime: 1000,
        knownSet: new Set(),
        tombstoneSet: new Set(),
      })

      expect(result.hasFailures).toBe(true)
      expect(onDecryptionFailureSpy).toHaveBeenCalledWith('item-bad', expect.any(Error))
    })

    it('handles batch fetch errors gracefully by setting hasFailures', async () => {
      mockApiClient.fetchSnapshotsByIds.mockRejectedValue(new Error('Network error'))

      const result = await hydrator.fetchAndHydrateRemoteItems({
        missingIds: ['item-err' as ItemId],
        manifest: [['item-err', 1000]],
        serverTime: 1000,
        knownSet: new Set(),
        tombstoneSet: new Set(),
      })

      expect(result.hasFailures).toBe(true)
      expect(result.added).toHaveLength(0)
    })
  })
})
