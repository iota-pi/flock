import { ManifestSyncManager } from './ManifestSyncManager'
import type { ItemId } from 'src/shared/schemas/items'

// Mock dependencies
const mockListAutomergeItemIds = vi.fn()
const mockListAutomergeTombstoneIds = vi.fn()
const mockRemoveAutomergeItemIdsFromIndex = vi.fn()
const mockHydrateAutomergeDocumentBinary = vi.fn()
const mockGetAutomergeMetadata = vi.fn()
const mockAddAutomergeItemIdsToIndex = vi.fn()
const mockGetLastManifestSyncTime = vi.fn()
const mockUpdateLastManifestSyncTime = vi.fn()

vi.mock('./docStore', () => ({
  AutomergeDocStore: vi.fn().mockImplementation(() => ({
    hydrateAutomergeDocumentBinary: mockHydrateAutomergeDocumentBinary,
  })),
  AutomergeIndexManager: vi.fn().mockImplementation(() => ({
    listAutomergeItemIds: mockListAutomergeItemIds,
    listAutomergeTombstoneIds: mockListAutomergeTombstoneIds,
    removeAutomergeItemIdsFromIndex: mockRemoveAutomergeItemIdsFromIndex,
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
const mockUpdateMetadataMutate = vi.fn().mockResolvedValue({ success: true })
vi.mock('../../api/trpcClient', () => ({
  getTrpcClient: () => ({
    accounts: {
      getMetadata: {
        query: (...args: any[]) => mockGetMetadataQuery(...args),
      },
      updateMetadata: {
        mutate: (...args: any[]) => mockUpdateMetadataMutate(...args),
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
      listAutomergeTombstoneIds: mockListAutomergeTombstoneIds,
      removeAutomergeItemIdsFromIndex: mockRemoveAutomergeItemIdsFromIndex,
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

    storeItemsSpy = vi.fn().mockResolvedValue(undefined)
    mutateMetadataSpy = vi.fn().mockResolvedValue(undefined)

    depsObj = {
      accountId: 'acc-123',
      docStore: mockDocStore,
      indexManager: mockIndexManager,
      snapshotManager: mockSnapshotManager,
      storeItems: storeItemsSpy,
      mutateMetadata: mutateMetadataSpy,
    } as any

    manifestSyncManager = new ManifestSyncManager(depsObj as any)

    // Default mock behaviors
    mockListAutomergeItemIds.mockResolvedValue([])
    mockListAutomergeTombstoneIds.mockResolvedValue([])
    mockRemoveAutomergeItemIdsFromIndex.mockResolvedValue(undefined)
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
    it('supports both unified ManifestSyncManagerDeps and legacy positional constructor arguments', () => {
      const unifiedManager = new ManifestSyncManager({
        ...(depsObj as any),
        storeItems: storeItemsSpy,
        mutateMetadata: mutateMetadataSpy,
      })
      expect(unifiedManager).toBeInstanceOf(ManifestSyncManager)

      const legacyManager = new ManifestSyncManager(
        depsObj as any,
        storeItemsSpy,
        mutateMetadataSpy,
      )
      expect(legacyManager).toBeInstanceOf(ManifestSyncManager)
    })

    it('returns early if accountId is null', async () => {
      depsObj.accountId = null

      const result = await manifestSyncManager.sync()

      expect(result).toEqual({ added: [], success: false })
      expect(mockListAutomergeItemIds).not.toHaveBeenCalled()
    })

    it('skips sync if known items exist and last sync was within 24 hours', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 3600 * 1000) // 1 hour ago

      const result = await manifestSyncManager.sync(false)

      expect(result).toEqual({ added: [], success: true })
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

      await new Promise(resolve => setTimeout(resolve, 0))

      expect(mockFetchManifest).toHaveBeenCalledTimes(1)

      resolveManifest({ manifest: [], serverTime: Date.now() })

      const [res1, res2] = await Promise.all([syncPromise1, syncPromise2])
      expect(res1).toEqual({ added: [], success: true })
      expect(res2).toEqual({ added: [], success: true })
      expect(mockFetchManifest).toHaveBeenCalledTimes(1)
    })

    it('returns early without throwing if hasApiAuthToken() is false and local items exist', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockHasApiAuthToken.mockReturnValue(false)

      const result = await manifestSyncManager.sync()

      expect(result).toEqual({ added: [], success: false })
      expect(mockFetchManifest).not.toHaveBeenCalled()
    })

    it('returns early without throwing if hasApiAuthToken() is false and no local items exist', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockHasApiAuthToken.mockReturnValue(false)

      const result = await manifestSyncManager.sync()

      expect(result).toEqual({ added: [], success: false })
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
      expect(result).toEqual({ added: ['item-snap'], success: true })
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
      expect(result).toEqual({ added: ['item-3'], success: true })
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
      expect(result).toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: [], success: true })
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

      expect(result).toEqual({ added: [], success: false })
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

  describe('syncMetadata', () => {
    it('pushes local metadata to server when remote is empty', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockGetAutomergeMetadata.mockResolvedValue({
        defaultPrayerFrequency: { person: 'daily' as const },
        prayerGoal: 5,
      })
      mockGetMetadataQuery.mockResolvedValue({
        success: true,
        metadata: {},
      })

      await manifestSyncManager.sync()

      expect(mockGetMetadataQuery).toHaveBeenCalledWith({ account: 'acc-123' })
      expect(mockUpdateMetadataMutate).toHaveBeenCalledWith({
        account: 'acc-123',
        metadata: expect.objectContaining({
          defaultPrayerFrequency: { person: 'daily' },
          prayerGoal: 5,
        }),
      })
    })

    it('hydrates metadata from trpc client into local store and preserves local sortCriteria', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockGetAutomergeMetadata.mockResolvedValue({
        sortCriteria: [{ type: 'name' as const, reverse: false }],
      })
      mockGetMetadataQuery.mockResolvedValue({
        success: true,
        metadata: {
          defaultPrayerFrequency: { person: 'weekly' as const },
          prayerGoal: 10,
          updatedAt: 1000,
        },
      })

      await manifestSyncManager.sync()

      expect(mockGetMetadataQuery).toHaveBeenCalledWith({ account: 'acc-123' })
      expect(mutateMetadataSpy).toHaveBeenCalledWith(
        {
          defaultPrayerFrequency: { person: 'weekly' },
          prayerGoal: 10,
          sortCriteria: [{ type: 'name', reverse: false }],
          updatedAt: 1000,
        },
        { pushRemote: false },
      )
    })

    it('reconciles bidirectional changes when both local and remote have updates', async () => {
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockGetAutomergeMetadata.mockResolvedValue({
        prayerGoal: 15,
        updatedAt: 2000,
      })
      mockGetMetadataQuery.mockResolvedValue({
        success: true,
        metadata: {
          defaultPrayerFrequency: { topic: 'daily' as const },
          updatedAt: 1000,
        },
      })

      await manifestSyncManager.sync()

      expect(mutateMetadataSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          prayerGoal: 15,
          defaultPrayerFrequency: { topic: 'daily' },
          updatedAt: 2000,
        }),
        { pushRemote: false },
      )
      expect(mockUpdateMetadataMutate).toHaveBeenCalledWith({
        account: 'acc-123',
        metadata: expect.objectContaining({
          prayerGoal: 15,
          defaultPrayerFrequency: { topic: 'daily' },
          updatedAt: 2000,
        }),
      })
    })

    it('swallows errors if remote metadata query fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-1', 100]],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      mockGetAutomergeMetadata.mockResolvedValue({})
      mockGetMetadataQuery.mockRejectedValue(new Error('TRPC error'))

      await expect(manifestSyncManager.sync()).resolves.toEqual({ added: [], success: true })
      expect(mutateMetadataSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
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
      expect(result).toEqual({ added: [], success: false })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Some batches or items failed to sync; lastManifestSyncTime not updated')
      )

      consoleSpy.mockRestore()
      warnSpy.mockRestore()
    })

    it('quarantines un-decryptable items to onDecryptionFailure without recording timestamp in lastModifiedStore', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const onDecryptionFailure = vi.fn()

      const manager = new ManifestSyncManager({
        ...(depsObj as any),
        storeItems: storeItemsSpy,
        mutateMetadata: mutateMetadataSpy,
        onDecryptionFailure,
      })

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
      expect(result).toEqual({ added: [], success: false })

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
      expect(result).toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: ['item-quarantined'], success: true })
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
      expect(result).toEqual({ added: ['item-quarantined'], success: true })
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
      expect(result).toEqual({ added: ['item-kver'], success: true })
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

      await expect(manifestSyncManager.sync()).resolves.toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: ['item-1'], success: true })

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
      expect(result).toEqual({ added: ['item-1'], success: true })

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
      expect(result).toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: [], success: true })
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
      expect(result).toEqual({ added: ['item-merged'], success: true })
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
      expect(result).toEqual({ added: ['item-clean'], success: true })
    })

    it('on initial login, skips snapshot downloads for tombstoned items and imports their timestamps', async () => {
      // Fresh client: no local items, no timestamps
      mockListAutomergeItemIds.mockResolvedValue([])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-active-1', 1000],
          ['item-tombstone-1', 2000, true],
          ['item-tombstone-2', 3000, true],
        ],
        serverTime: 3000,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-active-1',
            snapshot: { iv: 'iv-act', cipher: 'c-act' },
          },
        ],
        serverTime: 3000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: false,
        incomingHeads: ['head-1'],
      })

      const result = await manifestSyncManager.sync()

      // CRITICAL: fetchSnapshotsByIds must ONLY be called for active items, NEVER for tombstoned items
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-active-1'],
      })

      // Timestamps for tombstones must be imported so future syncs recognize them
      expect(depsObj.snapshotManager.importLastModified).toHaveBeenCalledWith(
        expect.arrayContaining([
          ['item-tombstone-1', 2000],
          ['item-tombstone-2', 3000],
        ])
      )

      expect(storeItemsSpy).not.toHaveBeenCalled()
      expect(result).toEqual({ added: ['item-active-1'], success: true })
    })

    it('tombstones local active item when server manifest marks it deleted, without snapshot download or upstream resurrection', async () => {
      // Client has item-local active locally
      mockListAutomergeItemIds.mockResolvedValue(['item-local' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-local', 1000]])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-local', 2000, true],
        ],
        serverTime: 2000,
      })

      const result = await manifestSyncManager.sync()

      // Must NOT fetch snapshot payload for deleted item
      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()

      // Must store tombstone locally with markDirty: false
      expect(storeItemsSpy).toHaveBeenCalledWith(
        [{ id: 'item-local', deleted: true }],
        { markDirty: false }
      )

      // Must NOT push item-local upstream
      expect(depsObj.snapshotManager.markItemDirty).not.toHaveBeenCalled()

      // Must import timestamp
      expect(depsObj.snapshotManager.importLastModified).toHaveBeenCalledWith([
        ['item-local', 2000],
      ])

      expect(result).toEqual({ added: [], success: true })
    })

    it('does NOT fetch or resurrect locally tombstoned items during forced sync when server has older active snapshot (C5 fix)', async () => {
      // Local client has item-deleted in tombstoneIds (not in active itemIds)
      mockListAutomergeItemIds.mockResolvedValue(['item-active' as ItemId])
      mockListAutomergeTombstoneIds.mockResolvedValue(['item-deleted' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([
        ['item-active', 100],
        ['item-deleted', 500],
      ])

      // Server manifest has an older active snapshot for item-deleted (isDeleted is undefined)
      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-active', 100],
          ['item-deleted', 200],
        ],
        serverTime: 500,
      })

      const result = await manifestSyncManager.sync(true)

      // Must NOT fetch snapshot payload for tombstoned item
      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      // Must NOT add tombstoned item to active items
      expect(result.added).toEqual([])
      expect(mockAddAutomergeItemIdsToIndex).not.toHaveBeenCalled()
      // Local tombstone is newer than server active snapshot, so must push tombstone upstream
      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-deleted', 2000)
    })

    it('does NOT fetch or resurrect locally tombstoned items tracked via localLastModified fallback during forced sync (C5 fix)', async () => {
      // Even if listAutomergeTombstoneIds is empty (e.g. legacy index before tombstoneIds field),
      // localLastModified tracks the item without it being in active itemIds
      mockListAutomergeItemIds.mockResolvedValue(['item-active' as ItemId])
      mockListAutomergeTombstoneIds.mockResolvedValue([])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([
        ['item-active', 100],
        ['item-legacy-deleted', 500],
      ])

      mockFetchManifest.mockResolvedValue({
        manifest: [
          ['item-active', 100],
          ['item-legacy-deleted', 200],
        ],
        serverTime: 500,
      })

      const result = await manifestSyncManager.sync(true)

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result.added).toEqual([])
      expect(mockAddAutomergeItemIdsToIndex).not.toHaveBeenCalled()
      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-legacy-deleted', 2000)
    })

    it('does NOT add fetched snapshot to hydratedIds or active index if resulting document is deleted (C5 fix)', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([])

      mockFetchManifest.mockResolvedValue({
        manifest: [['item-merged-deleted', 2000]],
        serverTime: 2000,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-merged-deleted',
            snapshot: { iv: 'iv', cipher: 'c' },
          },
        ],
        serverTime: 2000,
      })
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockHydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: true,
        incomingHeads: ['head-1'],
        isDeleted: true,
      })

      const result = await manifestSyncManager.sync()

      expect(mockAddAutomergeItemIdsToIndex).not.toHaveBeenCalled()
      expect(mockRemoveAutomergeItemIdsFromIndex).toHaveBeenCalledWith(['item-merged-deleted'])
      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-merged-deleted', 2000)
      expect(result.added).toEqual([])
    })

    it('does NOT overwrite local tombstone when fetched legacy cipher snapshot is not deleted (C5 fix)', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockListAutomergeTombstoneIds.mockResolvedValue(['item-legacy-tombstone' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-legacy-tombstone', 1000]])

      // Suppose item was fetched in batch
      mockFetchManifest.mockResolvedValue({
        manifest: [['item-legacy-tombstone', 500]],
        serverTime: 1000,
      })

      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [
          {
            item: 'item-legacy-tombstone',
            cipher: 'cipher-text',
            metadata: { iv: 'iv-text' },
          },
        ],
        serverTime: 500,
      })
      mockDecryptObject.mockResolvedValue({ id: 'item-legacy-tombstone', name: 'Zombie' })

      // Force item into missingIds by testing hydration directly or when pulled
      // In normal flow, tombstoneSet skips download. But if download happens:
      // We test that the legacy decryption branch guards against resurrecting item-legacy-tombstone
      // We can verify this by checking that storeItems is never called with the non-deleted zombie item
      const result = await manifestSyncManager.sync()

      expect(storeItemsSpy).not.toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'item-legacy-tombstone' })]),
        expect.anything()
      )
      expect(result.added).toEqual([])
    })
  })

  describe('discrete steps unit tests', () => {
    describe('calculateSyncDeltas', () => {
      it('partitions deltas correctly into missingIds, locallyTombstonedSnapshots, and upstreamIds', () => {
        const result = manifestSyncManager.calculateSyncDeltas({
          manifest: [
            ['item-new-remote', 2000],
            ['item-server-deleted', 2000, true],
            ['item-in-sync', 1000],
          ],
          clockSkew: 0,
          force: false,
          knownItemIds: ['item-server-deleted' as ItemId, 'item-in-sync' as ItemId, 'item-local-only' as ItemId],
          tombstoneItemIds: [],
          localLastModifiedMap: new Map([
            ['item-server-deleted', 1000],
            ['item-in-sync', 1000],
            ['item-local-only', 1500],
          ]),
          quarantinedMap: new Map(),
        })

        expect(result.missingIds).toEqual(['item-new-remote'])
        expect(result.locallyTombstonedSnapshots).toEqual([{ id: 'item-server-deleted', deleted: true }])
        expect(result.deletedLastModifiedUpdates).toEqual([['item-server-deleted', 2000]])
        expect(result.upstreamIds).toEqual(['item-local-only'])
        expect(result.knownSet.has('item-in-sync' as ItemId)).toBe(true)
      })

      it('filters quarantined items unless server has a newer timestamp', () => {
        const result = manifestSyncManager.calculateSyncDeltas({
          manifest: [
            ['item-quarantined-old', 500],
            ['item-quarantined-new', 1500],
          ],
          clockSkew: 0,
          force: false,
          knownItemIds: [],
          tombstoneItemIds: [],
          localLastModifiedMap: new Map(),
          quarantinedMap: new Map([
            ['item-quarantined-old' as ItemId, 600],
            ['item-quarantined-new' as ItemId, 1000],
          ]),
        })

        expect(result.missingIds).toEqual(['item-quarantined-new'])
      })
    })

    describe('hydrateRemoteItem', () => {
      it('returns structured success for active Automerge binary document', async () => {
        mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
        mockHydrateAutomergeDocumentBinary.mockResolvedValue({
          hasLocalChanges: false,
          incomingHeads: ['head-1'],
        })

        const item = {
          item: 'item-binary',
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
        }

        const result = await manifestSyncManager.hydrateRemoteItem(
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
      })

      it('returns structured success with markDirty when Automerge document has local changes', async () => {
        mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
        mockHydrateAutomergeDocumentBinary.mockResolvedValue({
          hasLocalChanges: true,
          incomingHeads: ['head-1'],
        })

        const item = {
          item: 'item-binary-changes',
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
        }

        const result = await manifestSyncManager.hydrateRemoteItem(
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
        expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-binary-changes', 2000)
      })

      it('returns structured success for deleted metadata without decryption', async () => {
        const item = {
          item: 'item-deleted-meta',
          metadata: { deleted: true },
        }

        const result = await manifestSyncManager.hydrateRemoteItem(
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

        const result = await manifestSyncManager.hydrateRemoteItem(
          item as any,
          [['item-un-decryptable', 1000]],
          new Set(),
        )

        expect(result.status).toBe('decryption_failure')
        expect(result.itemId).toBe('item-un-decryptable')
        expect((result as Extract<typeof result, { status: 'decryption_failure' }>).error.message).toContain('Failed to decrypt')
      })

      it('returns error when Automerge hydration throws', async () => {
        mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2]))
        mockHydrateAutomergeDocumentBinary.mockRejectedValue(new Error('WASM crash'))

        const item = {
          item: 'item-crash',
          snapshot: { iv: 'iv-1', cipher: 'c-1' },
        }

        const result = await manifestSyncManager.hydrateRemoteItem(
          item as any,
          [['item-crash', 1000]],
          new Set(),
        )

        expect(result.status).toBe('error')
        expect(result.itemId).toBe('item-crash')
        expect(((result as Extract<typeof result, { status: 'error' }>).error as Error).message).toBe('WASM crash')
      })
    })

    describe('pushLocalUpdates', () => {
      it('stores local tombstones, imports timestamps, and marks upstream dirty when passed SyncDeltas', async () => {
        await manifestSyncManager.pushLocalUpdates({
          missingIds: [],
          upstreamIds: ['item-up-1' as ItemId, 'item-up-2' as ItemId],
          locallyTombstonedSnapshots: [{ id: 'item-tomb-1', deleted: true } as any],
          deletedLastModifiedUpdates: [['item-tomb-1' as ItemId, 2500]],
          knownSet: new Set(),
          tombstoneSet: new Set(),
        })

        expect(storeItemsSpy).toHaveBeenCalledWith(
          [{ id: 'item-tomb-1', deleted: true }],
          { markDirty: false },
        )
        expect(depsObj.snapshotManager.importLastModified).toHaveBeenCalledWith([
          ['item-tomb-1', 2500],
        ])
        expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-up-1', 2000)
        expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-up-2', 2000)
      })

      it('marks upstream dirty when passed an array of ItemIds', async () => {
        await manifestSyncManager.pushLocalUpdates(['item-up-3' as ItemId])

        expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-up-3', 2000)
        expect(storeItemsSpy).not.toHaveBeenCalled()
      })
    })

    describe('cancellation and shutdown', () => {
      it('returns early when pre-aborted signal is provided', async () => {
        const controller = new AbortController()
        controller.abort()

        const result = await manifestSyncManager.sync(true, controller.signal)

        expect(result).toEqual({ added: [], success: false })
        expect(mockFetchManifest).not.toHaveBeenCalled()
      })

      it('returns early without work when manager is shut down', async () => {
        manifestSyncManager.shutdown()

        const result = await manifestSyncManager.sync(true)

        expect(result).toEqual({ added: [], success: false })
        expect(mockFetchManifest).not.toHaveBeenCalled()
      })

      it('aborts in-flight manifest fetch when aborted externally', async () => {
        const controller = new AbortController()
        mockFetchManifest.mockImplementation(async (_input: any, options?: { signal?: AbortSignal }) => {
          return new Promise((resolve, reject) => {
            if (options?.signal) {
              options.signal.addEventListener('abort', () => {
                const err = new Error('Aborted')
                err.name = 'AbortError'
                reject(err)
              })
            }
          })
        })

        const syncPromise = manifestSyncManager.sync(true, controller.signal)
        controller.abort()

        const result = await syncPromise
        expect(result).toEqual({ added: [], success: false })
      })

      it('aborts in-flight sync when abort() is called on the manager', async () => {
        mockFetchManifest.mockImplementation(async () => {
          manifestSyncManager.abort()
          return {
            manifest: [['item-remote-1', 1000, 1, 1]],
            serverTime: 1000,
          }
        })

        const result = await manifestSyncManager.sync(true)
        expect(result).toEqual({ added: [], success: false })
        expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      })
    })
  })
})

