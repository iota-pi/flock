import { ManifestSyncManager } from './ManifestSyncManager'
import type { ItemId } from 'src/shared/schemas/items'

// Mock dependencies
const mockListAutomergeItemIds = vi.fn()
const mockHydrateAutomergeDocumentBinary = vi.fn()
const mockGetAutomergeMetadata = vi.fn()
const mockAddAutomergeItemIdsToIndex = vi.fn()
const mockGetLastManifestSyncTime = vi.fn()
const mockUpdateLastManifestSyncTime = vi.fn()

vi.mock('./docStore', () => ({
  AutomergeDocStore: vi.fn().mockImplementation(() => ({
    hydrateAutomergeDocumentBinary: mockHydrateAutomergeDocumentBinary,
  })),
}))

vi.mock('./docStore/AutomergeIndexManager', () => ({
  AutomergeIndexManager: vi.fn().mockImplementation(() => ({
    listAutomergeItemIds: mockListAutomergeItemIds,
    getAutomergeMetadata: mockGetAutomergeMetadata,
    addAutomergeItemIdsToIndex: mockAddAutomergeItemIdsToIndex,
    getLastManifestSyncTime: mockGetLastManifestSyncTime,
    updateLastManifestSyncTime: mockUpdateLastManifestSyncTime,
  })),
}))

const mockFetchManifest = vi.fn()
const mockFetchSnapshotsByIds = vi.fn()
vi.mock('../../api/vault/ItemClient', () => ({
  fetchManifest: (...args: any[]) => mockFetchManifest(...args),
  fetchSnapshotsByIds: (...args: any[]) => mockFetchSnapshotsByIds(...args),
}))

const mockDecryptObject = vi.fn()
const mockDecryptBytes = vi.fn()
vi.mock('../../api/vault', () => ({
  decryptObject: (...args: any[]) => mockDecryptObject(...args),
  decryptBytes: (...args: any[]) => mockDecryptBytes(...args),
}))

const mockHasApiAuthToken = vi.fn()
vi.mock('../../api/runtime', () => ({
  hasApiAuthToken: () => mockHasApiAuthToken(),
}))

const mockGetMetadataQuery = vi.fn()
vi.mock('../../api/trpcClient', () => ({
  getTrpcClient: () => ({
    accounts: {
      getMetadata: {
        query: (...args: any[]) => mockGetMetadataQuery(...args),
      },
    },
  }),
}))

describe('ManifestSyncManager', () => {
  let manifestSyncManager: ManifestSyncManager
  let storeItemsSpy: any
  let mutateMetadataSpy: any
  let depsObj: { accountId: string | null; docStore: any; indexManager: any; snapshotManager: any }

  beforeEach(() => {
    vi.clearAllMocks()

    const mockDocStore = {
      hydrateAutomergeDocumentBinary: mockHydrateAutomergeDocumentBinary,
    } as any

    const mockIndexManager = {
      listAutomergeItemIds: mockListAutomergeItemIds,
      getAutomergeMetadata: mockGetAutomergeMetadata,
      addAutomergeItemIdsToIndex: mockAddAutomergeItemIdsToIndex,
      getLastManifestSyncTime: mockGetLastManifestSyncTime,
      updateLastManifestSyncTime: mockUpdateLastManifestSyncTime,
    } as any

    const mockSnapshotManager = {
      exportLastModified: vi.fn().mockReturnValue([]),
      importLastModified: vi.fn().mockResolvedValue(undefined),
    } as any

    depsObj = { accountId: 'acc-123', docStore: mockDocStore, indexManager: mockIndexManager, snapshotManager: mockSnapshotManager }
    storeItemsSpy = vi.fn().mockResolvedValue(undefined)
    mutateMetadataSpy = vi.fn().mockResolvedValue(undefined)

    manifestSyncManager = new ManifestSyncManager(
      depsObj as any,
      storeItemsSpy,
      mutateMetadataSpy
    )

    // Default mock behaviors
    mockListAutomergeItemIds.mockResolvedValue([])
    mockHasApiAuthToken.mockReturnValue(true)
    mockGetAutomergeMetadata.mockResolvedValue({})
    mockGetLastManifestSyncTime.mockResolvedValue(0)
    mockUpdateLastManifestSyncTime.mockResolvedValue(undefined)
    mockGetMetadataQuery.mockResolvedValue({ success: false })
  })

  describe('gating & lifecycle', () => {
    it('returns early if accountId is null', async () => {
      depsObj.accountId = null

      const result = await manifestSyncManager.sync()

      expect(result).toEqual({ added: [] })
      expect(mockListAutomergeItemIds).not.toHaveBeenCalled()
    })

    it('skips sync if known items exist and last sync was within 24 hours', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 3600 * 1000) // 1 hour ago

      const result = await manifestSyncManager.sync(false)

      expect(result).toEqual({ added: [] })
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })

    it('forces sync when force=true even within 24 hours', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 3600 * 1000)
      mockFetchManifest.mockResolvedValue({ manifest: [['item-1', 100]], serverTime: Date.now() })

      await manifestSyncManager.sync(true)

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' })
    })

    it('forces sync when offline for > 7 days even when force=false', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - EIGHT_DAYS_MS)
      mockFetchManifest.mockResolvedValue({ manifest: [['item-1', 100]], serverTime: Date.now() })

      await manifestSyncManager.sync(false)

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' })
    })

    it('returns early without throwing if hasApiAuthToken() is false and local items exist', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockHasApiAuthToken.mockReturnValue(false)

      const result = await manifestSyncManager.sync()

      expect(result).toEqual({ added: [] })
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })

    it('returns early without throwing if hasApiAuthToken() is false and no local items exist', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockHasApiAuthToken.mockReturnValue(false)

      const result = await manifestSyncManager.sync()

      expect(result).toEqual({ added: [] })
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })
  })

  describe('cold start & discovery', () => {
    it('performs cold start: fetches manifest, finds all missing items, fetches snapshots, and hydrates them', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-snap', 100],
          ['item-legacy', 200],
          ['item-deleted', 300],
        ],
        serverTime: Date.now(),
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-deleted',
            metadata: { deleted: true },
          },
          {
            item: 'item-snap',
            snapshot: { iv: 'iv-1', cipher: 'cipher-1', kver: '1' },
          },
          {
            item: 'item-legacy',
            cipher: 'legacy-cipher',
            metadata: { iv: 'legacy-iv' },
          },
        ],
        serverTime: Date.now(),
      })

      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockDecryptObject.mockResolvedValue({ type: 'person', name: 'Alice' })
      mockGetMetadataQuery.mockResolvedValue({ success: false })

      const result = await manifestSyncManager.sync()

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' })
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-snap', 'item-legacy', 'item-deleted'],
      })

      expect(mockDecryptBytes).toHaveBeenCalledWith({ iv: 'iv-1', cipher: 'cipher-1', kver: '1' })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-snap', new Uint8Array([1, 2, 3]))
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-snap'])

      expect(storeItemsSpy).toHaveBeenCalledWith([
        { id: 'item-deleted', deleted: true },
        { id: 'item-legacy', type: 'person', name: 'Alice' },
      ])

      expect(mockUpdateLastManifestSyncTime).toHaveBeenCalled()
      expect(result).toEqual({ added: ['item-snap'] })
    })

    it('performs warm path: fetches missing items and outdated known items', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 100], ['item-2', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-1', 100],
          ['item-2', 100],
          ['item-3', 150],
        ],
        serverTime: Date.now(),
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-3',
            snapshot: { iv: 'iv-3', cipher: 'cipher-3' },
          },
        ],
        serverTime: Date.now(),
      })

      mockDecryptBytes.mockResolvedValue(new Uint8Array([9, 9]))

      const result = await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-3'],
      })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-3', new Uint8Array([9, 9]))
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-3'])
      expect(result).toEqual({ added: ['item-3'] })
    })

    it('is a no-op when all manifest items are already known and up to date', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 100], ['item-2', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-1', 100],
          ['item-2', 100],
        ],
        serverTime: Date.now(),
      })

      const result = await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(mockUpdateLastManifestSyncTime).toHaveBeenCalled()
      expect(result).toEqual({ added: [] })
    })

    it('batches missing snapshot fetches in chunks of 50', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      const manifestEntries: Array<[string, number]> = Array.from({ length: 120 }, (_, i) => [
        `item-${i}`,
        100 + i,
      ])
      mockFetchManifest.mockResolvedValue({
        manifest: manifestEntries,
        serverTime: Date.now(),
      })

      mockFetchSnapshotsByIds.mockResolvedValue({ items: [], serverTime: Date.now() })

      await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledTimes(3)
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(1, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(0, 50).map(([id]) => id),
      })
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(2, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(50, 100).map(([id]) => id),
      })
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(3, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(100, 120).map(([id]) => id),
      })
    })

    it('falls back to local data if fetchManifest fails when known items exist', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockFetchManifest.mockRejectedValue(new Error('Network offline'))

      const result = await manifestSyncManager.sync()

      expect(result).toEqual({ added: [] })
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('throws if fetchManifest fails and no local items exist', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockRejectedValue(new Error('Network offline'))

      await expect(manifestSyncManager.sync()).rejects.toThrow('Failed to fetch manifest')
      consoleSpy.mockRestore()
    })
  })

  describe('hydrateMetadata', () => {
    it('skips metadata hydration if local metadata is not empty', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockGetAutomergeMetadata.mockResolvedValue({ accountName: 'Existing' })

      await manifestSyncManager.sync()

      expect(mockGetMetadataQuery).not.toHaveBeenCalled()
    })

    it('hydrates metadata from trpc client if empty locally', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockGetAutomergeMetadata.mockResolvedValue({})
      mockGetMetadataQuery.mockResolvedValue({
        success: true,
        metadata: { accountName: 'Fresh Account' },
      })

      await manifestSyncManager.sync()

      expect(mockGetMetadataQuery).toHaveBeenCalledWith({ account: 'acc-123' })
      expect(mutateMetadataSpy).toHaveBeenCalledWith({ accountName: 'Fresh Account' })
    })

    it('swallows errors if metadata hydration fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockGetAutomergeMetadata.mockResolvedValue({})
      mockGetMetadataQuery.mockRejectedValue(new Error('TRPC error'))

      await expect(manifestSyncManager.sync()).resolves.toEqual({ added: [] })
      expect(mutateMetadataSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
