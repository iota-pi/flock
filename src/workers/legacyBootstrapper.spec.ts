import { LegacyBootstrapper } from './legacyBootstrapper'

// Mock dependencies
const mockListAutomergeItemIds = vi.fn()
const mockHydrateAutomergeDocumentBinary = vi.fn()
const mockGetAutomergeMetadata = vi.fn()

vi.mock('../sync/docStore', () => ({
  listAutomergeItemIds: (...args: any[]) => mockListAutomergeItemIds(...args),
  hydrateAutomergeDocumentBinary: (...args: any[]) => mockHydrateAutomergeDocumentBinary(...args),
  getAutomergeMetadata: (...args: any[]) => mockGetAutomergeMetadata(...args),
}))

const mockFetchMany = vi.fn()
vi.mock('../api/vault/ItemClient', () => ({
  fetchMany: (...args: any[]) => mockFetchMany(...args),
}))

const mockDecryptObject = vi.fn()
const mockDecryptBytes = vi.fn()
vi.mock('../api/vault', () => ({
  decryptObject: (...args: any[]) => mockDecryptObject(...args),
  decryptBytes: (...args: any[]) => mockDecryptBytes(...args),
}))

const mockHasApiAuthToken = vi.fn()
vi.mock('../api/runtime', () => ({
  hasApiAuthToken: () => mockHasApiAuthToken(),
}))

const mockGetMetadataQuery = vi.fn()
vi.mock('../api/trpcClient', () => ({
  trpcClient: {
    accounts: {
      getMetadata: {
        query: (...args: any[]) => mockGetMetadataQuery(...args),
      },
    },
  },
}))

describe('LegacyBootstrapper', () => {
  let bootstrapper: LegacyBootstrapper
  let storeItemsSpy: any
  let mutateMetadataSpy: any
  let context: { accountId: string | null }

  beforeEach(() => {
    vi.clearAllMocks()

    context = { accountId: 'acc-123' }
    storeItemsSpy = vi.fn().mockResolvedValue(undefined)
    mutateMetadataSpy = vi.fn().mockResolvedValue(undefined)

    bootstrapper = new LegacyBootstrapper(
      () => context,
      storeItemsSpy,
      mutateMetadataSpy
    )

    // Set default mock behaviors
    mockListAutomergeItemIds.mockResolvedValue([])
    mockHasApiAuthToken.mockReturnValue(true)
    mockGetAutomergeMetadata.mockResolvedValue({})
  })

  describe('bootstrapLegacyItems', () => {
    it('returns early if accountId is null', async () => {
      context.accountId = null

      await bootstrapper.bootstrapLegacyItems()

      expect(mockListAutomergeItemIds).not.toHaveBeenCalled()
    })

    it('returns early if knownItemIds.length > 0 (already bootstrapped)', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])

      await bootstrapper.bootstrapLegacyItems()

      expect(mockFetchMany).not.toHaveBeenCalled()
    })

    it('throws error if hasApiAuthToken() is false', async () => {
      mockHasApiAuthToken.mockReturnValue(false)

      await expect(bootstrapper.bootstrapLegacyItems()).rejects.toThrow(
        '[LegacyBootstrapper] No API auth token found, cannot bootstrap legacy items'
      )
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

      await bootstrapper.bootstrapLegacyItems()

      expect(mockFetchMany).toHaveBeenCalledWith({ account: 'acc-123' })

      // Binary snapshot item decrypts & hydrates to automerge DocStore directly
      expect(mockDecryptBytes).toHaveBeenCalledWith({ iv: 'iv-1', cipher: 'cipher-1', kver: '1' })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith(
        'acc-123',
        'item-snap',
        new Uint8Array([5, 6, 7])
      )

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

      await bootstrapper.bootstrapLegacyItems()

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

      await bootstrapper.bootstrapLegacyItems()

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

      await bootstrapper.bootstrapLegacyItems()

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

      await expect(bootstrapper.bootstrapLegacyItems()).resolves.toBeUndefined()
      expect(mutateMetadataSpy).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })
})
