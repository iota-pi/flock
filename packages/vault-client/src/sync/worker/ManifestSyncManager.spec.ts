import { ManifestSyncManager } from './ManifestSyncManager'
import { RecoveryManager } from './RecoveryManager'
import { ClientEventHub } from './SyncEventHub'
import { SyncApiClient } from './SyncApiClient'
import type { ItemId } from '@vault/shared'

// Mock dependencies
const mockListAutomergeItemIds = vi.fn()
const mockListAutomergeTombstoneIds = vi.fn()
const mockRemoveAutomergeItemIdsFromIndex = vi.fn()
const mockHydrateAutomergeDocumentBinary = vi.fn()
const mockGetAutomergeMetadata = vi.fn()
const mockAddAutomergeItemIdsToIndex = vi.fn()
const mockGetLastManifestSyncTime = vi.fn()
const mockUpdateLastManifestSyncTime = vi.fn()

const mockFetchManifest = vi.fn()
const mockFetchSnapshotsByIds = vi.fn()
import { createMockKeyProvider, createMockVault } from './__test__/testUtils'
import { spyOnExports } from '../../../test/moduleMocks'
import * as docStoreModule from './docStore'
import * as itemClient from './ItemClient'
import * as manualRecoveryStoreModule from '../shared/manualRecoveryStore'
import * as runtimeModule from '../../api/runtime'

const mockVault = createMockVault()
const keys = createMockKeyProvider(mockVault)
const {
  decryptBytes: mockDecryptBytes,
  hasVaultKey: mockHasVaultKey,
  waitForKeyVersion: mockWaitForKeyVersion,
} = mockVault
const mockReadManualRecoveryEntries = vi.fn().mockResolvedValue([])
const mockHasApiAuthToken = vi.fn()
beforeEach(() => {
  spyOnExports(docStoreModule, {
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
  })
  spyOnExports(itemClient, {
    fetchManifest: (...args: any[]) => mockFetchManifest(...args),
    fetchSnapshotsByIds: (...args: any[]) => mockFetchSnapshotsByIds(...args),
  })
  spyOnExports(manualRecoveryStoreModule, {
    readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
  })
  spyOnExports(runtimeModule, {
    setApiAuthToken: vi.fn(),
    hasApiAuthToken: () => mockHasApiAuthToken(),
    getApiAuthToken: () => (mockHasApiAuthToken() ? 'session-token' : ''),
  })
})

describe('ManifestSyncManager', () => {
  let manifestSyncManager: ManifestSyncManager
  let storeItemsSpy: any
  let migrateLegacySettingsSpy: any
  let depsObj: { accountId: string | null; docStore: any; indexManager: any; snapshotManager: any }

  beforeEach(() => {
    vi.clearAllMocks()
    mockVault.reset()

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
      exportItemVersions: vi.fn().mockImplementation(() => {
        const versions = new Map<ItemId, { baseVersion: number; isDirty: boolean }>()
        const lastModifiedList = (mockSnapshotManager.exportLastModified?.() ?? []) as Array<[ItemId, number]>
        for (const [id] of lastModifiedList) {
          versions.set(id, { baseVersion: 1, isDirty: false })
        }
        return versions
      }),
      importVersions: vi.fn().mockResolvedValue(undefined),
      deleteDirtyItem: vi.fn().mockReturnValue(true),
      flushPendingSnapshots: vi.fn().mockResolvedValue({ persisted: 0, total: 0 }),
      markItemDirty: vi.fn(),
    } as any

    storeItemsSpy = vi.fn().mockResolvedValue(undefined)
    migrateLegacySettingsSpy = vi.fn().mockResolvedValue(undefined)

    depsObj = {
      accountId: 'acc-123',
      docStore: mockDocStore,
      indexManager: mockIndexManager,
      snapshotManager: mockSnapshotManager,
      keys,
      storeItems: storeItemsSpy,
      migrateLegacySettings: migrateLegacySettingsSpy,
      recoveryManager: new RecoveryManager({ accountId: 'acc-123', eventHub: new ClientEventHub() }),
      apiClient: new SyncApiClient(),
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
    mockHydrateAutomergeDocumentBinary.mockResolvedValue(undefined)
    mockHasVaultKey.mockReturnValue(true)
    mockWaitForKeyVersion.mockResolvedValue(true)
    mockReadManualRecoveryEntries.mockResolvedValue([])
  })

  describe('gating & lifecycle', () => {
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
      mockFetchManifest.mockResolvedValue({ manifest: [{ itemId: 'item-1', modifiedAt: 100 }], serverTime: Date.now() })

      await manifestSyncManager.sync(true)

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' }, { signal: expect.any(AbortSignal) })
    })

    it('forces sync when offline for > 7 days even when force=false', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - EIGHT_DAYS_MS)
      mockFetchManifest.mockResolvedValue({ manifest: [{ itemId: 'item-1', modifiedAt: 100 }], serverTime: Date.now() })

      await manifestSyncManager.sync(false)

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' }, { signal: expect.any(AbortSignal) })
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
          { itemId: 'item-snap', modifiedAt: 100 },
          { itemId: 'item-legacy', modifiedAt: 200 },
          { itemId: 'item-deleted', modifiedAt: 300 },
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
      const decodeLegacyItem = vi.fn().mockResolvedValue({ type: 'person', name: 'Alice' })
      const manager = new ManifestSyncManager({ ...depsObj, decodeLegacyItem } as any)

      const result = await manager.sync()

      expect(mockFetchManifest).toHaveBeenCalledWith({ account: 'acc-123' }, { signal: expect.any(AbortSignal) })
      expect(mockFetchSnapshotsByIds).toHaveBeenCalledWith({
        account: 'acc-123',
        itemIds: ['item-snap', 'item-legacy', 'item-deleted'],
      }, { signal: expect.any(AbortSignal) })

      expect(mockDecryptBytes).toHaveBeenCalledWith({ iv: 'iv-1', cipher: 'cipher-1', kver: '1' }, 'item-snap')
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-snap', new Uint8Array([1, 2, 3]), { knownToExist: false })
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-snap'])

      expect(decodeLegacyItem).toHaveBeenCalledWith(
        expect.objectContaining({ item: 'item-legacy', cipher: 'legacy-cipher' }),
        expect.objectContaining({ ensureKey: expect.any(Function) }),
      )
      expect(storeItemsSpy).toHaveBeenCalledWith([{ id: 'item-deleted', deleted: true }], { markDirty: false })
      // Decoded legacy items upload a snapshot straight away
      expect(storeItemsSpy).toHaveBeenCalledWith(
        [{ id: 'item-legacy', type: 'person', name: 'Alice' }],
        { markDirty: true },
      )

      expect(mockUpdateLastManifestSyncTime).toHaveBeenCalled()
      expect(result).toEqual({ added: ['item-snap'], success: true })
    })

    it('reports legacy rows without a hook as needing migration, and does not count the sync as complete', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-legacy', modifiedAt: 200 }],
        serverTime: Date.now(),
      })
      mockFetchSnapshotsByIds.mockResolvedValue({
        items: [{ item: 'item-legacy', cipher: 'legacy-cipher', metadata: { iv: 'legacy-iv' } }],
      })
      const onMigrationRequired = vi.fn()
      const onSyncedWithoutFailures = vi.fn()
      const manager = new ManifestSyncManager({ ...depsObj, onMigrationRequired, onSyncedWithoutFailures } as any)

      const result = await manager.sync()

      expect(result).toEqual({ added: [], success: false })
      expect(onMigrationRequired).toHaveBeenCalledTimes(1)
      expect(onSyncedWithoutFailures).not.toHaveBeenCalled()
      expect(storeItemsSpy).not.toHaveBeenCalled()
    })

    it('performs warm path: fetches missing items and outdated known items', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1' as ItemId, 'item-2' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 100], ['item-2', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-1', modifiedAt: 100 },
          { itemId: 'item-2', modifiedAt: 100 },
          { itemId: 'item-3', modifiedAt: 150 },
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
      }, { signal: expect.any(AbortSignal) })
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
          { itemId: 'item-1', modifiedAt: 100 },
          { itemId: 'item-2', modifiedAt: 100 },
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
          { itemId: 'item-active', modifiedAt: 100 },
          { itemId: 'item-deleted', modifiedAt: 100 },
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
      const manifestEntries = Array.from({ length: 120 }, (_, i) => ({
        itemId: `item-${i}`,
        modifiedAt: 100 + i,
      }))
      mockFetchManifest.mockResolvedValue({
        manifest: manifestEntries,
        serverTime: Date.now(),
      })

      mockFetchSnapshotsByIds.mockResolvedValue({ items: [], serverTime: Date.now() })

      await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).toHaveBeenCalledTimes(3)
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(1, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(0, 50).map(e => e.itemId),
      }, { signal: expect.any(AbortSignal) })
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(2, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(50, 100).map(e => e.itemId),
      }, { signal: expect.any(AbortSignal) })
      expect(mockFetchSnapshotsByIds).toHaveBeenNthCalledWith(3, {
        account: 'acc-123',
        itemIds: manifestEntries.slice(100, 120).map(e => e.itemId),
      }, { signal: expect.any(AbortSignal) })
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

  describe('legacy settings migration', () => {
    beforeEach(() => {
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
        serverTime: Date.now(),
      })
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
    })

    it('migrates legacy settings after each manifest sync', async () => {
      await manifestSyncManager.sync()

      expect(migrateLegacySettingsSpy).toHaveBeenCalledTimes(1)
    })

    it('does nothing without a migration hook', async () => {
      const manager = new ManifestSyncManager({ ...depsObj, migrateLegacySettings: undefined } as any)

      await expect(manager.sync()).resolves.toEqual({ added: [], success: true })
    })

    it('treats a failed migration as non-fatal so it retries on the next sync', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      migrateLegacySettingsSpy.mockRejectedValueOnce(new Error('TRPC error'))

      await expect(manifestSyncManager.sync()).resolves.toEqual({ added: [], success: true })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Legacy settings migration skipped'),
        expect.any(Error),
      )
      warnSpy.mockRestore()
    })
  })

  describe('fetchManifestEverySync', () => {
    it('fetches the manifest even when a sync ran within the day', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1' as ItemId])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 1000)
      mockFetchManifest.mockResolvedValue({ manifest: [], serverTime: Date.now() })
      const manager = new ManifestSyncManager({ ...depsObj, fetchManifestEverySync: true } as any)

      await manager.sync()

      expect(mockFetchManifest).toHaveBeenCalledTimes(1)
    })
  })

  describe('onSyncedWithoutFailures', () => {
    it('is called after a sync in which every item hydrated', async () => {
      const onSyncedWithoutFailures = vi.fn()
      const manager = new ManifestSyncManager({ ...depsObj, onSyncedWithoutFailures } as any)
      mockFetchManifest.mockResolvedValue({ manifest: [], serverTime: Date.now() })
      mockListAutomergeItemIds.mockResolvedValue([])

      await expect(manager.sync()).resolves.toEqual({ added: [], success: true })
      expect(onSyncedWithoutFailures).toHaveBeenCalledTimes(1)
    })

    it('is called when the sync is skipped because a clean sync ran recently', async () => {
      const onSyncedWithoutFailures = vi.fn()
      const manager = new ManifestSyncManager({ ...depsObj, onSyncedWithoutFailures } as any)
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(Date.now() - 1000)

      await expect(manager.sync()).resolves.toEqual({ added: [], success: true })
      expect(mockFetchManifest).not.toHaveBeenCalled()
      expect(onSyncedWithoutFailures).toHaveBeenCalledTimes(1)
    })

    it('is not called when an item failed to hydrate', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const onSyncedWithoutFailures = vi.fn()
      const manager = new ManifestSyncManager({ ...depsObj, onSyncedWithoutFailures } as any)
      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
        serverTime: Date.now(),
      })
      mockFetchSnapshotsByIds.mockRejectedValue(new Error('Network error fetching batch'))

      await manager.sync()

      expect(onSyncedWithoutFailures).not.toHaveBeenCalled()
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    })
  })

  describe('lockout prevention on failure', () => {
    it('does NOT update lastManifestSyncTime when a snapshot batch fails to fetch', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [
          { itemId: 'item-1', modifiedAt: 100 },
          { itemId: 'item-2', modifiedAt: 200 },
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
        manifest: [{ itemId: 'item-corrupt', modifiedAt: 100 }],
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
        onDecryptionFailure,
      })

      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-undecryptable', modifiedAt: 500 }],
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
        expect.any(Error),
        undefined,
      )
      // Timestamp MUST NOT be recorded in SnapshotManager to prevent permanent lockout
      expect(depsObj.snapshotManager.importLastModified).not.toHaveBeenCalled()
      // Hydration failure prevents updating lastManifestSyncTime
      expect(mockUpdateLastManifestSyncTime).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [], success: false })

      warnSpy.mockRestore()
    })

    it('skips quarantined items without a newer server version during routine sync to prevent endless retry loops', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500, serverVersion: 3 },
      ])
      mockFetchManifest.mockResolvedValue({
        // A server clock far ahead of the quarantine time doesn't matter, only the version does
        manifest: [{ itemId: 'item-quarantined', version: 3, modifiedAt: 999_999 }],
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
        manifest: [{ itemId: 'item-quarantined', modifiedAt: 500 }],
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
      }, { signal: expect.any(AbortSignal) })
      expect(result).toEqual({ added: ['item-quarantined'], success: true })
    })

    it('retries quarantined items when server has a newer version than the one that failed', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockReadManualRecoveryEntries.mockResolvedValue([
        { id: 'item-quarantined', itemId: 'item-quarantined', reason: 'fail', createdAt: 500, serverVersion: 3 },
      ])
      mockFetchManifest.mockResolvedValue({
        // A server clock behind the quarantine time doesn't matter, only the version does
        manifest: [{ itemId: 'item-quarantined', version: 4, modifiedAt: 100 }],
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
      }, { signal: expect.any(AbortSignal) })
      expect(result).toEqual({ added: ['item-quarantined'], success: true })
    })

    it('waits for missing key version before attempting snapshot decryption', async () => {
      mockListAutomergeItemIds.mockResolvedValue([])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-kver', modifiedAt: 500 }],
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

  describe('manifest diffing', () => {
    it('flushes pending snapshots before evaluating manifest diffs', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
        serverTime: Date.now(),
      })

      await manifestSyncManager.sync()

      expect(depsObj.snapshotManager.flushPendingSnapshots).toHaveBeenCalledTimes(1)
      // Otherwise the manifest misses the flushed items and they are pushed a second time
      expect(depsObj.snapshotManager.flushPendingSnapshots.mock.invocationCallOrder[0])
        .toBeLessThan(mockFetchManifest.mock.invocationCallOrder[0])
    })

    it('continues gracefully if flushPendingSnapshots throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      depsObj.snapshotManager.flushPendingSnapshots.mockRejectedValue(new Error('Flush failed'))

      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 100]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 100 }],
        serverTime: Date.now(),
      })

      await expect(manifestSyncManager.sync()).resolves.toEqual({ added: [], success: true })
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to flush pending snapshots before sync'),
        expect.any(Error)
      )
      warnSpy.mockRestore()
    })

    it('skips fetching when the server version matches the local base version', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 5000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 9000 }],
        serverTime: 6000,
      })

      const result = await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [], success: true })
    })

    it('pulls a known item when the server version is newer, whatever the timestamps', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      // The local timestamp is far ahead of the server's, which does not matter
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 1_250_000]])
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', modifiedAt: 1_050_000, version: 2 }],
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
      }, { signal: expect.any(AbortSignal) })
      expect(mockHydrateAutomergeDocumentBinary).toHaveBeenCalledWith('item-1', new Uint8Array([1, 2, 3]), { knownToExist: true })
      expect(result).toEqual({ added: ['item-1'], success: true })
    })

    it('pushes a dirty item instead of pulling a server snapshot at the same version', async () => {
      mockListAutomergeItemIds.mockResolvedValue(['item-1'])
      mockGetLastManifestSyncTime.mockResolvedValue(0)
      depsObj.snapshotManager.exportLastModified.mockReturnValue([['item-1', 1_980_000]])
      depsObj.snapshotManager.exportItemVersions.mockReturnValue(
        new Map([['item-1', { baseVersion: 1, isDirty: true }]]),
      )
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-1', version: 1, modifiedAt: 900_000 }],
        serverTime: 1_000_000,
      })

      const result = await manifestSyncManager.sync()

      expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      expect(result).toEqual({ added: [], success: true })
      expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-1', 2000)
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
      depsObj.snapshotManager.exportItemVersions.mockReturnValue(
        new Map([['item-newer', { baseVersion: 1, isDirty: true }]]),
      )
      mockFetchManifest.mockResolvedValue({
        manifest: [{ itemId: 'item-newer', modifiedAt: itemServerTime }],
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
        manifest: [{ itemId: 'item-synced', modifiedAt: serverTime }],
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
        manifest: [{ itemId: 'item-pulling', modifiedAt: 2000 }],
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
          { itemId: 'item-offline', modifiedAt: 2000 }, // older on server, so it won't be fetched
          { itemId: 'item-server', modifiedAt: 3000 },  // missing locally, so it will be fetched
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
        manifest: [{ itemId: 'item-merged', modifiedAt: 2000, version: 2 }],
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
        manifest: [{ itemId: 'item-clean', modifiedAt: 2000, version: 2 }],
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
          { itemId: 'item-active-1', modifiedAt: 1000 },
          { itemId: 'item-tombstone-1', modifiedAt: 2000, isDeleted: true },
          { itemId: 'item-tombstone-2', modifiedAt: 3000, isDeleted: true },
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
      }, { signal: expect.any(AbortSignal) })

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
          { itemId: 'item-local', modifiedAt: 2000, isDeleted: true },
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

      // Must delete from dirtyItems to prevent unintentional resurrection/upload
      expect(depsObj.snapshotManager.deleteDirtyItem).toHaveBeenCalledWith('item-local')

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
          { itemId: 'item-active', modifiedAt: 100 },
          { itemId: 'item-deleted', modifiedAt: 200 },
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
          { itemId: 'item-active', modifiedAt: 100 },
          { itemId: 'item-legacy-deleted', modifiedAt: 200 },
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
        manifest: [{ itemId: 'item-merged-deleted', modifiedAt: 2000 }],
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
        manifest: [{ itemId: 'item-legacy-tombstone', modifiedAt: 500 }],
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
      const decodeLegacyItem = vi.fn().mockResolvedValue({ id: 'item-legacy-tombstone', name: 'Zombie' })
      const manager = new ManifestSyncManager({ ...depsObj, decodeLegacyItem } as any)

      // Force item into missingIds by testing hydration directly or when pulled
      // In normal flow, tombstoneSet skips download. But if download happens:
      // We test that the legacy decoding branch guards against resurrecting item-legacy-tombstone
      // We can verify this by checking that storeItems is never called with the non-deleted zombie item
      const result = await manager.sync()

      expect(storeItemsSpy).not.toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'item-legacy-tombstone' })]),
        expect.anything()
      )
      expect(result.added).toEqual([])
    })
  })

  describe('discrete steps unit tests', () => {
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
        expect(depsObj.snapshotManager.deleteDirtyItem).toHaveBeenCalledWith('item-tomb-1')
        expect(depsObj.snapshotManager.importLastModified).toHaveBeenCalledWith([
          ['item-tomb-1', 2500],
        ])
        expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-up-1', 2000)
        expect(depsObj.snapshotManager.markItemDirty).toHaveBeenCalledWith('item-up-2', 2000)
      })

      it('calls deleteDirtyItem on server-deleted items even if storeItems throws', async () => {
        storeItemsSpy.mockRejectedValueOnce(new Error('Storage failure'))

        await expect(
          manifestSyncManager.pushLocalUpdates({
            missingIds: [],
            upstreamIds: [],
            locallyTombstonedSnapshots: [{ id: 'item-fail-1', deleted: true } as any],
            deletedLastModifiedUpdates: [['item-fail-1' as ItemId, 2500]],
            knownSet: new Set(),
            tombstoneSet: new Set(),
          }),
        ).rejects.toThrow('Storage failure')

        expect(depsObj.snapshotManager.deleteDirtyItem).toHaveBeenCalledWith('item-fail-1')
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
            manifest: [{ itemId: 'item-remote-1', modifiedAt: 1000 }],
            serverTime: 1000,
          }
        })

        const result = await manifestSyncManager.sync(true)
        expect(result).toEqual({ added: [], success: false })
        expect(mockFetchSnapshotsByIds).not.toHaveBeenCalled()
      })

      it('cancels the in-flight manifest fetch of a background sync on abort()', async () => {
        let fetchSignal: AbortSignal | undefined
        mockFetchManifest.mockImplementation((_input: any, options?: { signal?: AbortSignal }) => {
          fetchSignal = options?.signal
          return new Promise(() => {})
        })

        void manifestSyncManager.sync(true)
        await vi.waitFor(() => expect(mockFetchManifest).toHaveBeenCalled())
        manifestSyncManager.abort()

        expect(fetchSignal?.aborted).toBe(true)
      })
    })
  })
})

