import { VaultBootstrapper } from './VaultBootstrapper'

// Mock dependencies
const mockListAutomergeItemIds = vi.fn()
const mockHydrateAutomergeDocumentBinary = vi.fn()
const mockGetAutomergeMetadata = vi.fn()
const mockAddAutomergeItemIdsToIndex = vi.fn()

vi.mock('./docStore', () => ({
  AutomergeDocStore: vi.fn().mockImplementation(() => ({
    hydrateAutomergeDocumentBinary: mockHydrateAutomergeDocumentBinary,
  }))
}))

const mockGetLastSyncTime = vi.fn()

vi.mock('./docStore/AutomergeIndexManager', () => ({
  AutomergeIndexManager: vi.fn().mockImplementation(() => ({
    listAutomergeItemIds: mockListAutomergeItemIds,
    getAutomergeMetadata: mockGetAutomergeMetadata,
    addAutomergeItemIdsToIndex: mockAddAutomergeItemIdsToIndex,
    getLastSyncTime: mockGetLastSyncTime,
  }))
}))

const mockFetchMany = vi.fn()
vi.mock('../../api/vault/ItemClient', () => ({
  fetchMany: (...args: any[]) => mockFetchMany(...args),
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

describe('VaultBootstrapper', () => {
  let bootstrapper: VaultBootstrapper
  let storeItemsSpy: any
  let mutateMetadataSpy: any
  let depsObj: { accountId: string | null; docStore: any; indexManager: any }

  beforeEach(() => {
    vi.clearAllMocks()

    const mockDocStore = {
      hydrateAutomergeDocumentBinary: mockHydrateAutomergeDocumentBinary,
    } as any

    const mockIndexManager = {
      listAutomergeItemIds: mockListAutomergeItemIds,
      getAutomergeMetadata: mockGetAutomergeMetadata,
      addAutomergeItemIdsToIndex: mockAddAutomergeItemIdsToIndex,
      getLastSyncTime: mockGetLastSyncTime,
    } as any

    depsObj = { accountId: 'acc-123', docStore: mockDocStore, indexManager: mockIndexManager }
    storeItemsSpy = vi.fn().mockResolvedValue(undefined)
    mutateMetadataSpy = vi.fn().mockResolvedValue(undefined)

    bootstrapper = new VaultBootstrapper(
      depsObj as any,
      storeItemsSpy,
      mutateMetadataSpy
    )

    // Set default mock behaviors
    mockListAutomergeItemIds.mockResolvedValue([])
    mockHasApiAuthToken.mockReturnValue(true)
    mockGetAutomergeMetadata.mockResolvedValue({})
    mockGetLastSyncTime.mockResolvedValue(Date.now())
  })

  describe('bootstrapItems', () => {
    it('returns early if accountId is null', async () => {
      depsObj.accountId = null

      await bootstrapper.bootstrapItems()

      expect(mockListAutomergeItemIds).not.toHaveBeenCalled()
    })

    it('returns early if knownItemIds.length > 0 (already bootstrapped) and not offline for too long', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastSyncTime.mockResolvedValue(Date.now() - 1000)

      await bootstrapper.bootstrapItems()

      expect(mockFetchMany).not.toHaveBeenCalled()
    })

    it('does not return early if offline for > 1 week (minus buffer)', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
      const BUFFER_MS = 12 * 60 * 60 * 1000
      mockGetLastSyncTime.mockResolvedValue(Date.now() - (SEVEN_DAYS_MS - BUFFER_MS + 1000))
      
      mockFetchMany.mockResolvedValue({ items: [] })

      await bootstrapper.bootstrapItems()

      expect(mockFetchMany).toHaveBeenCalled()
    })

    it('returns early without throwing if hasApiAuthToken() is false', async () => {
      mockHasApiAuthToken.mockReturnValue(false)

      await expect(bootstrapper.bootstrapItems()).resolves.toBeUndefined()
      expect(mockFetchMany).not.toHaveBeenCalled()
    })

    it('processes deleted, snapshot, and legacy object envelopes correctly', async () => {
      const fetchedItems = [
        // 1. Deleted item
        {
          item: 'item-deleted',
          metadata: { deleted: true },
        },
        // 2. Binary snapshot item
        {
          item: 'item-snap',
          snapshot: { iv: 'iv-1', cipher: 'cipher-1', kver: '1' },
        },
        // 3. Legacy legacy encrypted object item
        {
          item: 'item-legacy',
          cipher: 'legacy-cipher',
          metadata: { iv: 'legacy-iv' },
        },
      ]

      mockFetchMany.mockResolvedValue({ items: fetchedItems })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([5, 6, 7]))
      mockDecryptObject.mockResolvedValue({ type: 'person', name: 'John' })
      mockGetMetadataQuery.mockResolvedValue({ success: false }) // Skip metadata for now

      await bootstrapper.bootstrapItems()

      expect(mockFetchMany).toHaveBeenCalledWith({ account: 'acc-123' })

      // Binary snapshot item decrypts & hydrates to automerge DocStore directly
      expect(mockDecryptBytes).toHaveBeenCalledWith({ iv: 'iv-1', cipher: 'cipher-1', kver: '1' })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith(
        'item-snap',
        new Uint8Array([5, 6, 7])
      )
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-snap'])

      // Deleted items & legacy decrypted object snapshots are passed to storeItems
      expect(storeItemsSpy).toHaveBeenCalledWith([
        { id: 'item-deleted', deleted: true },
        { id: 'item-legacy', type: 'person', name: 'John' },
      ])
    })

    it('handles decryption/processing errors gracefully and continues with other items', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const fetchedItems = [
        {
          item: 'item-bad',
          snapshot: { iv: 'bad-iv', cipher: 'bad-cipher', kver: '1' },
        },
        {
          item: 'item-good',
          metadata: { deleted: true },
        },
      ]

      mockFetchMany.mockResolvedValue({ items: fetchedItems })
      mockDecryptBytes.mockRejectedValue(new Error('Decryption failed'))

      await bootstrapper.bootstrapItems()

      expect(consoleSpy).toHaveBeenCalled()
      expect(storeItemsSpy).toHaveBeenCalledWith([
        { id: 'item-good', deleted: true },
      ])

      consoleSpy.mockRestore()
    })
  })

  describe('hydrateMetadata', () => {
    it('skips metadata hydration if local metadata is not empty', async () => {
      mockFetchMany.mockResolvedValue({
        items: [{ item: 'item-1', metadata: { deleted: true } }]
      })
      mockGetAutomergeMetadata.mockResolvedValue({ some: 'metadata' })

      await bootstrapper.bootstrapItems()

      expect(mockGetMetadataQuery).not.toHaveBeenCalled()
    })

    it('hydrates metadata from trpc client if empty locally', async () => {
      mockFetchMany.mockResolvedValue({
        items: [{ item: 'item-1', metadata: { deleted: true } }]
      })
      mockGetAutomergeMetadata.mockResolvedValue({}) // empty
      mockGetMetadataQuery.mockResolvedValue({
        success: true,
        metadata: { accountName: 'Test Account' },
      })

      await bootstrapper.bootstrapItems()

      expect(mockGetMetadataQuery).toHaveBeenCalledWith({ account: 'acc-123' })
      expect(mutateMetadataSpy).toHaveBeenCalledWith({ accountName: 'Test Account' })
    })

    it('swallows errors if metadata hydration fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockFetchMany.mockResolvedValue({
        items: [{ item: 'item-1', metadata: { deleted: true } }]
      })
      mockGetAutomergeMetadata.mockResolvedValue({})
      mockGetMetadataQuery.mockRejectedValue(new Error('TRPC failed'))

      await expect(bootstrapper.bootstrapItems()).resolves.toBeUndefined()
      expect(mutateMetadataSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
