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
const mockHasVaultKey = vi.fn().mockReturnValue(true)
const mockWaitForKeyVersion = vi.fn().mockResolvedValue(true)
vi.mock('../../api/vault', () => ({
  decryptObject: (...args: any[]) => mockDecryptObject(...args),
  decryptBytes: (...args: any[]) => mockDecryptBytes(...args),
  hasVaultKey: (...args: any[]) => mockHasVaultKey(...args),
  waitForKeyVersion: (...args: any[]) => mockWaitForKeyVersion(...args),
}))

const mockReadManualRecoveryEntries = vi.fn().mockResolvedValue([])
vi.mock('../shared/manualRecoveryStore', () => ({
  readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
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
      flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 0, total: 0 }),
      markItemDirty: vi.fn(),
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
    mockHydrateAutomergeDocumentBinary.mockResolvedValue(undefined)
    mockHasVaultKey.mockReturnValue(true)
    mockWaitForKeyVersion.mockResolvedValue(true)
    mockReadManualRecoveryEntries.mockResolvedValue([])
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

    it('shares in-flight sync promise across concurrent sync calls', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      let resolveManifest: (val: any) => void = () => {}
      mockFetchManifest.mockImplementation(
        () => new Promise(resolve => { resolveManifest = resolve })
      )

      const syncPromise1 = manifestSyncManager.sync(true)
      const syncPromise2 = manifestSyncManager.sync(false)

      await Promise.resolve()
      await Promise.resolve()

      expect(mockFetchManifest).toHaveBeenCalledTimes(1)

      resolveManifest({ manifest: [], serverTime: Date.now() })

      const [res1, res2] = await Promise.all([syncPromise1, syncPromise2])
      expect(res1).toEqual({ added: [] })
      expect(res2).toEqual({ added: [] })
      expect(mockFetchManifest).toHaveBeenCalledTimes(1)
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
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-snap', new Uint8Array([1, 2, 3]), { knownToExist: false })
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-snap'])

      expect(storeItemsSpy).toHaveBeenCalledWith(
        [
          { id: 'item-deleted', deleted: true },
          { id: 'item-legacy', type: 'person', name: 'Alice' },
        ],
        { markDirty: false },
      )

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
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-3', new Uint8Array([9, 9]), { knownToExist: false })
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

    it('is a no-op when manifest contains an already-synced deleted item not in knownSet', async () => {
      // Deleted items are excluded from active index doc (listAutomergeItemIds)
      mockListAutomergeItemIds.mockResolvedValue(['item-active' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // Both active and deleted items have their last modified timestamp tracked in snapshotManager
      depsObj.snapshotManager.exportLastModified.mockReturnValue([
        ['item-active', 100],
        ['item-deleted', 100],
      ])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-active', 100],
          ['item-deleted', 100],
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

  describe('lockout prevention on failure', () => {
    it('does NOT update lastManifestSyncTime when a snapshot batch fails to fetch', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-1', 100],
          ['item-2', 200],
        ],
        serverTime: Date.now(),
      })

      // Batch fetch fails with network error
      mockFetchSnapshotsByIds.mockRejectedValue(new Error('Network error fetching batch'))

      await manifestSyncManager.sync()

      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Some batches or items failed to sync; lastManifestSyncTime not updated')
      )

      consoleSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it('does NOT update lastManifestSyncTime when item hydration throws an error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-corrupt', 100]],
        serverTime: Date.now(),
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-corrupt',
            snapshot: { iv: 'iv-c', cipher: 'c-c' },
          },
        ],
        serverTime: Date.now(),
      })

      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2]))
      mockHydrateAutomergeDocumentBinary.mockRejectedValue(new Error('CRDT hydration crashed'))

      const result = await manifestSyncManager.sync()

      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(mockAddAutomergeItemIdsToIndex).not.toHaveBeenCalled()
      expect(depsObj.snapshotManager.importLastModified).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [] })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Some batches or items failed to sync; lastManifestSyncTime not updated')
      )

      consoleSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it('quarantines un-decryptable items to onDecryptionFailure without recording timestamp in lastModifiedStore', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onDecryptionFailure = vi.fn()

      const manager = new ManifestSyncManager(
        depsObj as any,
        storeItemsSpy,
        mutateMetadataSpy,
        onDecryptionFailure
      )

      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-undecryptable', 500]],
        serverTime: 500,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-undecryptable',
            snapshot: { iv: 'bad-iv', cipher: 'bad-cipher' },
          },
        ],
        serverTime: 500,
      })

      // decrypt fails (missing key or corrupted ciphertext)
      mockDecryptBytes.mockResolvedValue(null)

      const result = await manager.sync()

      expect(onDecryptionFailure).toHaveBeenCalledWith(
        'item-undecryptable',
        expect.any(Error)
      )
      // Timestamp MUST NOT be recorded in SnapshotManager to prevent permanent lockout
      expect(depsObj.snapshotManager.importLastModified).not.toHaveBeenCalled()
      // Hydration failure prevents updating lastManifestSyncTime
      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [] })

      warnSpy.mockRestore()
    })

    it('skips quarantined items without newer server timestamps during routine sync to prevent endless retry loops', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500 },
      ])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-quarantined', 500]],
        serverTime: 500,
      })

      const result = await manifestSyncManager.sync(false)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [] })
    })

    it('retries quarantined items when force=true even without newer server timestamps', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500 },
      ])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-quarantined', 500]],
        serverTime: 500,
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-quarantined',
            snapshot: { iv: 'iv-ok', cipher: 'cipher-ok', kver: '1' },
          },
        ],
        serverTime: 500,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const result = await manifestSyncManager.sync(true)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-quarantined'],
      })
      expect(result).toEqual({ added: ['item-quarantined'] })
    })

    it('retries quarantined items when server has a newer timestamp than quarantine time', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500 },
      ])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-quarantined', 600]],
        serverTime: 600,
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-quarantined',
            snapshot: { iv: 'iv-ok', cipher: 'cipher-ok', kver: '1' },
          },
        ],
        serverTime: 600,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const result = await manifestSyncManager.sync(false)

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-quarantined'],
      })
      expect(result).toEqual({ added: ['item-quarantined'] })
    })

    it('waits for missing key version before attempting snapshot decryption', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-kver', 500]],
        serverTime: 500,
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-kver',
            snapshot: { iv: 'iv-1', cipher: 'cipher-1', kver: '2' },
          },
        ],
        serverTime: 500,
      })

      mockHasVaultKey.mockImplementation(kver => kver !== '2')
      mockWaitForKeyVersion.mockImplementation(async kver => {
        if (kver === '2') {
          mockHasVaultKey.mockReturnValue(true)
          return true
        }
        return false
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([9, 8, 7]))

      const result = await manifestSyncManager.sync(false)

      expect(mockWaitForKeyVersion).toHaveBeenCalledWith('2', 3000)
      expect(mockDecryptBytes).toHaveBeenCalled()
      expect(result).toEqual({ added: ['item-kver'] })
    })
  })

  describe('clock skew compensation & safety buffer', () => {
    it('flushes pending snapshots before evaluating manifest diffs', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })

      await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.flushPendingSnapshots).toHaveBeenCalledTimes(1)
    })

    it('continues gracefully if flushPendingSnapshots throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      depsObj.snapshotManager.flushPendingSnapshots.mockRejectedValue(new Error('Flush failed'))

      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })

      await expect(manifestSyncManager.sync()).resolves.toEqual({ added: [] })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to flush pending snapshots before sync'),
        expect.any(Error)
      )
      warnSpy.mockRestore()
    })

    it('skips fetching when serverTime === localTime (exact match guard)', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 5000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 5000]],
        serverTime: 6000,
      })

      const result = await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [] })
    })

    it('pulls valid server update when client clock is ahead of server (fast client clock)', async () => {
      // Client is ahead of server:
      // Client time: 1,300,000 (Date.now())
      // Server response serverTime: 1,000,000
      // clockSkew = 1,300,000 - 1,000,000 = 300,000 ms (5 mins fast)
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_300_000)

      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // Local client previously saved timestamp with fast clock:
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 1_250_000]])

      // Server has update for item-1 with server timestamp 1,050,000:
      // Without compensation: 1,050,000 > 1,250,000 is FALSE (missed update)
      // With compensation: adjusted = 1,250,000 - 300,000 - 60,000 = 890,000; 1,050,000 > 890,000 is TRUE
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 1_050_000]],
        serverTime: 1_000_000,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-1',
            snapshot: { iv: 'iv-1', cipher: 'c-1' },
          },
        ],
        serverTime: 1_000_000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      const result = await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-1'],
      })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-1', new Uint8Array([1, 2, 3]), { knownToExist: true })
      expect(result).toEqual({ added: ['item-1'] })

      dateNowSpy.mockRestore()
    })

    it('pulls server update within 60-second SKEW_BUFFER_MS window when timestamps differ', async () => {
      // Client time == Server time (0 clock skew)
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // Local client timestamp is slightly ahead (e.g. 20 seconds ahead due to clock drift)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 500_020]])

      // Server timestamp is 500_000 (differing, but within 60s buffer)
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 500_000]],
        serverTime: 1_000_000,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-1',
            snapshot: { iv: 'iv-1', cipher: 'c-1' },
          },
        ],
        serverTime: 1_000_000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([4, 5, 6]))

      const result = await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-1'],
      })
      expect(result).toEqual({ added: ['item-1'] })

      dateNowSpy.mockRestore()
    })

    it('does not redundantly pull older server snapshots when local client clock is ahead of server', async () => {
      // Client time is 2,000,000 while server time is 1,000,000 (clockSkew = 1,000,000)
      const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000_000)

      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // Local time is physically in server's future (1_980_000 vs serverTime 1_000_000, equivalent to 980_000 in server time)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 1_980_000]])

      // Server manifest has older snapshot 900_000 for item-1 and serverTime is 1_000_000
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 900_000]],
        serverTime: 1_000_000,
      })

      const result = await manifestSyncManager.sync()

      // Should NOT fetch snapshot since local item is newer in server timeline (980k > 900k)
      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [] })
      // Local is newer so upstream reconciliation should queue it for push
      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-1', 2000)

      dateNowSpy.mockRestore()
    })
  })

  describe('Two-Way Manifest Reconciliation (Upstream)', () => {
    it('marks item dirty with 2s debounce when local item is missing entirely from server manifest', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-local-only' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-local-only', 1000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [],
        serverTime: 1000,
      })

      const result = await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-local-only', 2000)
      expect(result).toEqual({ added: [] })
    })

    it('marks item dirty with 2s debounce when local item is newer than server snapshot', async () => {
      const now = Date.now()
      const itemServerTime = now - 120_000 // Server snapshot is 2 minutes old
      const localTime = now // Local was edited just now

      mockListAutomergeItemIds.mockResolvedValue(['item-newer' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-newer', localTime]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-newer', itemServerTime]],
        serverTime: now,
      })

      const result = await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-newer', 2000)
      expect(result).toEqual({ added: [] })
    })

    it('does not mark item dirty when local item is equal to or older than server snapshot', async () => {
      const serverTime = 500_000

      mockListAutomergeItemIds.mockResolvedValue(['item-synced' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-synced', serverTime]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-synced', serverTime]],
        serverTime,
      })

      const result = await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.markItemDirty).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [] })
    })

    it('does not mark item dirty upstream if it is currently being pulled downstream in missingIds', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-pulling' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-pulling', 0]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-pulling', 2000]],
        serverTime: 2000,
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-pulling',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
        serverTime: 2000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1]))

      await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.markItemDirty).not.toHaveBeenCalled()
    })

    it('only passes updated items to importLastModified without including other existing items (B5 fix)', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-offline' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // Existing item in snapshot manager with local edits
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-offline', 5000]])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-offline', 2000], // older on server, so it won't be fetched
          ['item-server', 3000],  // missing locally, so it will be fetched
        ],
        serverTime: 3000,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-server',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
        serverTime: 3000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))

      await manifestSyncManager.sync()

      // importLastModified must only be called with item-server updates, never including item-offline
      expect(depsObj.snapshotManager.importLastModified).toHaveBeenCalledTimes(1)
      expect(depsObj.snapshotManager.importLastModified).toHaveBeenCalledWith([
        ['item-server', 3000],
      ])
    })

    it('marks item dirty upstream and omits from lastModifiedUpdates when hydration merges local edits (hasLocalChanges is true)', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-merged' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-merged', 1000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-merged', 2000]],
        serverTime: 2000,
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-merged',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
        serverTime: 2000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: true,
        incomingHeads: ['remote-head-1'],
      })

      const result = await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-merged', 2000)
      expect(depsObj.snapshotManager.importLastModified).not.toHaveBeenCalled()
      expect(result).toEqual({ added: ['item-merged'] })
    })

    it('does not mark item dirty and includes in lastModifiedUpdates when hydration has no local edits (hasLocalChanges is false)', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-clean' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-clean', 1000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-clean', 2000]],
        serverTime: 2000,
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-clean',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
        serverTime: 2000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: false,
        incomingHeads: ['remote-head-1'],
      })

      const result = await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.markItemDirty).not.toHaveBeenCalled()
      expect(depsObj.snapshotManager.importLastModified).toHaveBeenCalledWith([
        ['item-clean', 2000],
      ])
      expect(result).toEqual({ added: ['item-clean'] })
    })
  })
})


