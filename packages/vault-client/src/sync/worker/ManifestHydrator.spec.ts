import { ManifestHydrator } from './ManifestHydrator'
import type { ItemId } from '@vault/shared/ids'

import { createMockKeyProvider, createMockVault } from './__test__/testUtils'

const mockVault = createMockVault()
const keys = createMockKeyProvider(mockVault)
const {
  decryptBytes: mockDecryptBytes,
  decryptObject: mockDecryptObject,
} = mockVault

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
    mockVault.reset()

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
      importVersions: vi.fn().mockResolvedValue(undefined),
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
      keys,
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
        [{ itemId: 'item-binary' as ItemId, modifiedAt: 2000 }],
        new Set(['item-binary' as ItemId]),
      )

      expect(result).toEqual({
        status: 'success',
        itemId: 'item-binary',
        hydratedId: 'item-binary',
        lastModifiedUpdate: ['item-binary', 2000],
        versionUpdate: ['item-binary', 1],
      })
      expect(onItemSnapshotHydratedSpy).toHaveBeenCalledWith('item-binary', ['head-1'])
    })

    it('does not notify onItemSnapshotHydrated when incomingHeads is missing', async () => {
      mockDecryptBytes.mockResolvedValue(new Uint8Array([1, 2, 3]))
      mockDocStore.hydrateAutomergeDocumentBinary.mockResolvedValue({
        hasLocalChanges: false,
      })

      const item = {
        item: 'item-no-heads',
        snapshot: { iv: 'iv-1', cipher: 'c-1' },
      }

      const result = await hydrator.hydrateRemoteItem(
        item as any,
        [{ itemId: 'item-no-heads' as ItemId, modifiedAt: 2000 }],
        new Set(['item-no-heads' as ItemId]),
      )

      expect(result).toEqual({
        status: 'success',
        itemId: 'item-no-heads',
        hydratedId: 'item-no-heads',
        lastModifiedUpdate: ['item-no-heads', 2000],
        versionUpdate: ['item-no-heads', 1],
      })
      expect(onItemSnapshotHydratedSpy).not.toHaveBeenCalled()
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
        [{ itemId: 'item-binary-changes' as ItemId, modifiedAt: 2000, version: 3 }],
        new Set(['item-binary-changes' as ItemId]),
      )

      expect(result).toEqual({
        status: 'success',
        itemId: 'item-binary-changes',
        hydratedId: 'item-binary-changes',
        lastModifiedUpdate: undefined,
        versionUpdate: ['item-binary-changes', 3],
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
        [{ itemId: 'item-deleted-meta' as ItemId, modifiedAt: 3000, version: 5 }],
        new Set(),
      )

      expect(result).toEqual({
        status: 'success',
        itemId: 'item-deleted-meta',
        snapshot: { id: 'item-deleted-meta', deleted: true },
        lastModifiedUpdate: ['item-deleted-meta', 3000],
        versionUpdate: ['item-deleted-meta', 5],
      })
      expect(mockDecryptBytes).not.toHaveBeenCalled()
      expect(mockDecryptObject).not.toHaveBeenCalled()
    })

    it('returns decryption_failure when the snapshot cannot be decrypted', async () => {
      mockDecryptBytes.mockResolvedValue(null)

      const item = {
        item: 'item-un-decryptable',
        snapshot: { iv: 'iv-bad', cipher: 'c-bad' },
      }

      const result = await hydrator.hydrateRemoteItem(
        item as any,
        [{ itemId: 'item-un-decryptable' as ItemId, modifiedAt: 1000 }],
        new Set(),
      )

      expect(result.status).toBe('decryption_failure')
      expect(result.itemId).toBe('item-un-decryptable')
      expect((result as any).error.message).toContain('Failed to decrypt')
    })
  })

  describe('legacy items', () => {
    const legacyRow = { item: 'item-legacy', cipher: 'legacy-cipher', metadata: { iv: 'legacy-iv', kver: '2' } }
    let decodeLegacyItem: any

    function createHydrator() {
      return new ManifestHydrator({
        accountId: 'acc-test',
        apiClient: mockApiClient,
        docStore: mockDocStore,
        indexManager: mockIndexManager,
        snapshotManager: mockSnapshotManager,
        keys,
        storeItems: storeItemsSpy,
        onDecryptionFailure: onDecryptionFailureSpy,
        decodeLegacyItem,
      })
    }

    beforeEach(() => {
      decodeLegacyItem = vi.fn().mockResolvedValue({ type: 'person', name: 'Alice' })
    })

    it('decodes rows without a snapshot through the hook', async () => {
      const result = await createHydrator().hydrateRemoteItem(
        legacyRow as any,
        [{ itemId: 'item-legacy' as ItemId, modifiedAt: 2000, version: 4 }],
        new Set(),
      )

      expect(decodeLegacyItem).toHaveBeenCalledWith(legacyRow, expect.objectContaining({ ensureKey: expect.any(Function) }))
      expect(result).toEqual({
        status: 'success',
        itemId: 'item-legacy',
        legacySnapshot: { id: 'item-legacy', type: 'person', name: 'Alice' },
        lastModifiedUpdate: ['item-legacy', 2000],
        versionUpdate: ['item-legacy', 4],
      })
    })

    it('stores decoded items as dirty, so they upload a snapshot', async () => {
      mockApiClient.fetchSnapshotsByIds.mockResolvedValue({ items: [legacyRow] })

      const result = await createHydrator().fetchAndHydrateRemoteItems({
        missingIds: ['item-legacy' as ItemId],
        manifest: [{ itemId: 'item-legacy' as ItemId, modifiedAt: 2000 }],
        serverTime: 2000,
        knownSet: new Set(),
        tombstoneSet: new Set(),
      })

      expect(result.hasFailures).toBe(false)
      expect(storeItemsSpy).toHaveBeenCalledTimes(1)
      expect(storeItemsSpy).toHaveBeenCalledWith(
        [{ id: 'item-legacy', type: 'person', name: 'Alice' }],
        { markDirty: true },
      )
    })

    it('lets the hook wait for the key version', async () => {
      mockVault.hasVaultKey.mockReturnValue(false)
      mockVault.waitForKeyVersion.mockResolvedValue(true)
      const onKeyVersionMissing = vi.fn()
      decodeLegacyItem.mockImplementation(async (_item: unknown, context: any) => {
        expect(await context.ensureKey('2')).toBe(true)
        return { type: 'person' }
      })
      const withKeyHandler = new ManifestHydrator({
        accountId: 'acc-test',
        apiClient: mockApiClient,
        docStore: mockDocStore,
        indexManager: mockIndexManager,
        snapshotManager: mockSnapshotManager,
        keys,
        storeItems: storeItemsSpy,
        onKeyVersionMissing,
        decodeLegacyItem,
      })

      const result = await withKeyHandler.hydrateRemoteItem(legacyRow as any, [], new Set())

      expect(result.status).toBe('success')
      expect(onKeyVersionMissing).toHaveBeenCalledWith('2')
      expect(mockVault.waitForKeyVersion).toHaveBeenCalledWith('2', expect.any(Number))
    })

    it('reports a decryption failure when the hook cannot decode the row', async () => {
      decodeLegacyItem.mockResolvedValue(null)
      const result = await createHydrator().hydrateRemoteItem(legacyRow as any, [], new Set())
      expect(result.status).toBe('decryption_failure')
    })

    it('reports a decryption failure when the hook throws', async () => {
      decodeLegacyItem.mockRejectedValue(new Error('bad cipher'))
      const result = await createHydrator().hydrateRemoteItem(legacyRow as any, [], new Set())
      expect(result.status).toBe('decryption_failure')
    })

    it('reports a decryption failure without a hook', async () => {
      const result = await hydrator.hydrateRemoteItem(legacyRow as any, [], new Set())
      expect(result.status).toBe('decryption_failure')
    })

    it('never falls back to the legacy payload when the snapshot fails to decrypt', async () => {
      mockDecryptBytes.mockResolvedValue(null)

      const result = await createHydrator().hydrateRemoteItem(
        { ...legacyRow, snapshot: { iv: 'iv-bad', cipher: 'c-bad' } } as any,
        [],
        new Set(),
      )

      expect(result.status).toBe('decryption_failure')
      expect(decodeLegacyItem).not.toHaveBeenCalled()
    })

    it('does not resurrect a locally deleted item, and marks it dirty', async () => {
      const result = await createHydrator().hydrateRemoteItem(
        legacyRow as any,
        [{ itemId: 'item-legacy' as ItemId, modifiedAt: 2000, version: 4 }],
        new Set(),
        new Set(['item-legacy' as ItemId]),
      )

      expect(result).toEqual({ status: 'success', itemId: 'item-legacy', versionUpdate: ['item-legacy', 4] })
      expect(mockIndexManager.removeAutomergeItemIdsFromIndex).toHaveBeenCalledWith(['item-legacy'])
      expect(mockSnapshotManager.markItemDirty).toHaveBeenCalledWith('item-legacy', expect.any(Number))
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
        manifest: [{ itemId: 'item-1' as ItemId, modifiedAt: 1000 }],
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
        manifest: [{ itemId: 'item-bad' as ItemId, modifiedAt: 1000 }],
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
        manifest: [{ itemId: 'item-err' as ItemId, modifiedAt: 1000 }],
        serverTime: 1000,
        knownSet: new Set(),
        tombstoneSet: new Set(),
      })

      expect(result.hasFailures).toBe(true)
      expect(result.added).toHaveLength(0)
    })

    it('limits concurrent hydration tasks to hydrationConcurrency limit (M-18)', async () => {
      const items = Array.from({ length: 10 }, (_, i) => ({
        item: `item-${i}`,
        metadata: { deleted: true },
      }))
      mockApiClient.fetchSnapshotsByIds.mockResolvedValue({ items })

      const concurrencyLimit = 3
      const customHydrator = new ManifestHydrator({
        accountId: 'acc-test',
        apiClient: mockApiClient,
        docStore: mockDocStore,
        indexManager: mockIndexManager,
        snapshotManager: mockSnapshotManager,
        keys,
        storeItems: storeItemsSpy,
        hydrationConcurrency: concurrencyLimit,
      })

      let activeCount = 0
      let peakConcurrency = 0
      const originalHydrate = customHydrator.hydrateRemoteItem.bind(customHydrator)
      vi.spyOn(customHydrator, 'hydrateRemoteItem').mockImplementation(async (...args) => {
        activeCount += 1
        peakConcurrency = Math.max(peakConcurrency, activeCount)
        await new Promise(resolve => setTimeout(resolve, 15))
        activeCount -= 1
        return originalHydrate(...args)
      })

      const missingIds = items.map(entry => entry.item as ItemId)
      const manifest = items.map(entry => ({ itemId: entry.item as ItemId, modifiedAt: 1000 }))

      const result = await customHydrator.fetchAndHydrateRemoteItems({
        missingIds,
        manifest,
        serverTime: 1000,
        knownSet: new Set(),
        tombstoneSet: new Set(),
      })

      expect(result.hasFailures).toBe(false)
      expect(peakConcurrency).toBe(concurrencyLimit)
      expect(storeItemsSpy).toHaveBeenCalled()
    })

    it('settles unexpected hydration rejection without halting processing of remaining items', async () => {
      const items = [
        { item: 'item-1', metadata: { deleted: true } },
        { item: 'item-crash', metadata: { deleted: true } },
        { item: 'item-2', metadata: { deleted: true } },
      ]
      mockApiClient.fetchSnapshotsByIds.mockResolvedValue({ items })

      const originalHydrate = hydrator.hydrateRemoteItem.bind(hydrator)
      vi.spyOn(hydrator, 'hydrateRemoteItem').mockImplementation(async (item, ...rest) => {
        if (item.item === 'item-crash') {
          throw new Error('Catastrophic failure in item-crash')
        }
        return originalHydrate(item, ...rest)
      })

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await hydrator.fetchAndHydrateRemoteItems({
        missingIds: items.map(e => e.item as ItemId),
        manifest: items.map(e => ({ itemId: e.item as ItemId, modifiedAt: 1000 })),
        serverTime: 1000,
        knownSet: new Set(),
        tombstoneSet: new Set(),
      })

      expect(result.hasFailures).toBe(true)
      expect(storeItemsSpy).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'item-1' }),
          expect.objectContaining({ id: 'item-2' }),
        ]),
        { markDirty: false },
      )
      consoleErrorSpy.mockRestore()
    })

    it('aborts immediately and throws when AbortSignal is aborted during concurrent hydration', async () => {
      const items = Array.from({ length: 8 }, (_, i) => ({
        item: `item-${i}`,
        metadata: { deleted: true },
      }))
      mockApiClient.fetchSnapshotsByIds.mockResolvedValue({ items })

      const controller = new AbortController()
      let executedCount = 0

      vi.spyOn(hydrator, 'hydrateRemoteItem').mockImplementation(async () => {
        executedCount += 1
        if (executedCount === 2) {
          controller.abort()
        }
        await new Promise(resolve => setTimeout(resolve, 20))
        return { status: 'success', itemId: 'item-0' as ItemId }
      })

      await expect(
        hydrator.fetchAndHydrateRemoteItems(
          {
            missingIds: items.map(e => e.item as ItemId),
            manifest: items.map(e => ({ itemId: e.item as ItemId, modifiedAt: 1000 })),
            serverTime: 1000,
            knownSet: new Set(),
            tombstoneSet: new Set(),
          },
          controller.signal,
        ),
      ).rejects.toThrow()
    })
  })
})
