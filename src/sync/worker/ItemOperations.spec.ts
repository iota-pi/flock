import { ItemOperations, ItemOperationsDeps } from './ItemOperations'
import { SyncApiClient } from './SyncApiClient'
import type { Item } from '../../state/items'
import type { ItemId } from 'src/shared/schemas/items'

const mockPublishRealtimeBusSyncPing = vi.fn()
vi.mock('./realtimeBus', () => ({
  publishRealtimeBusSyncPing: (...args: any[]) => mockPublishRealtimeBusSyncPing(...args),
}))

const mockReadManualRecoveryEntries = vi.fn()
const mockReadManualRecoveryCount = vi.fn()
const mockRemoveManualRecoveryEntryById = vi.fn()
const mockRemoveManualRecoveryEntryByItemId = vi.fn()
const mockUpsertManualRecoveryEntry = vi.fn()

vi.mock('../shared/manualRecoveryStore', () => ({
  readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
  readManualRecoveryCount: (...args: any[]) => mockReadManualRecoveryCount(...args),
  removeManualRecoveryEntryById: (...args: any[]) => mockRemoveManualRecoveryEntryById(...args),
  removeManualRecoveryEntryByItemId: (...args: any[]) => mockRemoveManualRecoveryEntryByItemId(...args),
  upsertManualRecoveryEntry: (...args: any[]) => mockUpsertManualRecoveryEntry(...args),
}))

describe('ItemOperations', () => {
  let deps: ItemOperationsDeps
  let operations: ItemOperations
  let mockApiClient: {
    hasAuthToken: ReturnType<typeof vi.fn>
    updateAccountMetadata: ReturnType<typeof vi.fn>
  }
  let emitMock: any
  let changeDocumentMock: any
  let compactDocumentMock: any
  let addAutomergeItemIdsToIndexMock: any
  let removeAutomergeItemIdsFromIndexMock: any
  let markDocumentDirtyMock: any
  let getAutomergeItemMock: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishRealtimeBusSyncPing.mockClear()
    mockApiClient = {
      hasAuthToken: vi.fn().mockResolvedValue(true),
      updateAccountMetadata: vi.fn().mockResolvedValue(undefined),
    }
    mockReadManualRecoveryEntries.mockResolvedValue([])
    mockReadManualRecoveryCount.mockResolvedValue(0)
    mockRemoveManualRecoveryEntryById.mockResolvedValue(undefined)
    mockRemoveManualRecoveryEntryByItemId.mockResolvedValue(undefined)
    mockUpsertManualRecoveryEntry.mockResolvedValue(undefined)
    emitMock = vi.fn()
    changeDocumentMock = vi.fn()
    compactDocumentMock = vi.fn().mockResolvedValue(undefined)
    addAutomergeItemIdsToIndexMock = vi.fn()
    removeAutomergeItemIdsFromIndexMock = vi.fn().mockResolvedValue(undefined)
    markDocumentDirtyMock = vi.fn()
    getAutomergeItemMock = vi.fn()

    deps = {
      accountId: 'account-1',
      docStore: {
        changeDocument: changeDocumentMock,
        getAutomergeItem: getAutomergeItemMock,
        compactDocument: compactDocumentMock,
        removeAutomergeItem: vi.fn(),
      } as any,
      indexManager: {
        addAutomergeItemIdsToIndex: addAutomergeItemIdsToIndexMock,
        listAutomergeItemIds: vi.fn().mockResolvedValue([]),
        removeAutomergeItemIdsFromIndex: removeAutomergeItemIdsFromIndexMock,
        updateAutomergeMetadata: vi.fn(),
        getAutomergeMetadata: vi.fn(),
      } as any,
      eventHub: {
        emit: emitMock,
      } as any,
      markDocumentDirty: markDocumentDirtyMock,
      apiClient: mockApiClient as unknown as SyncApiClient,
    }

    operations = new ItemOperations(deps)
  })

  describe('createItem', () => {
    const testItem = { id: 'item-1' as ItemId, type: 'note', text: 'hello' } as unknown as Item

    it('indexes and marks document dirty when changeDocument succeeds', async () => {
      changeDocumentMock.mockResolvedValue(true)

      await operations.createItem(testItem)

      expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['item-1'])
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-1')
      expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith('account-1', ['item-1'])
      expect(emitMock).not.toHaveBeenCalled()
    })

    it('emits mutationFailed and itemUpdated with null when changeDocument returns false', async () => {
      changeDocumentMock.mockResolvedValue(false)
      getAutomergeItemMock.mockResolvedValue(null)

      await operations.createItem(testItem)

      expect(addAutomergeItemIdsToIndexMock).not.toHaveBeenCalled()
      expect(markDocumentDirtyMock).not.toHaveBeenCalled()
      expect(emitMock).toHaveBeenCalledWith({
        type: 'mutationFailed',
        mutationType: 'create',
        error: 'Failed to create document item-1',
      })
      expect(getAutomergeItemMock).toHaveBeenCalledWith('item-1')
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: 'item-1',
        item: null,
      })
    })

    it('emits mutationFailed when changeDocument throws', async () => {
      changeDocumentMock.mockRejectedValue(new Error('Storage unavailable'))

      await operations.createItem(testItem)

      expect(emitMock).toHaveBeenCalledWith({
        type: 'mutationFailed',
        mutationType: 'create',
        error: 'Storage unavailable',
      })
    })
  })

  describe('mutateItem', () => {
    const itemId = 'item-1' as ItemId
    const changes = { text: 'updated text' }

    it('marks document dirty when changeDocument succeeds', async () => {
      changeDocumentMock.mockResolvedValue(true)

      await operations.mutateItem(itemId, changes)

      expect(markDocumentDirtyMock).toHaveBeenCalledWith(itemId)
      expect(emitMock).not.toHaveBeenCalled()
    })

    it('applies scalar changes and reconciles array changes in changeDocument callback', async () => {
      let changeCallback: ((doc: any) => void) | undefined
      changeDocumentMock.mockImplementation(async (_id: any, cb: any) => {
        changeCallback = cb
        return true
      })

      const testDoc: any = {
        name: 'Old Name',
        notes: [{ id: 'n1', text: 'Old note', archived: false, time: 100 }],
        members: ['m1'],
      }

      await operations.mutateItem(itemId, {
        name: 'New Name',
        notes: [
          { id: 'n2', text: 'New note', archived: false, time: 200 },
          { id: 'n1', text: 'Edited note', archived: true, time: 100 },
        ],
        members: ['m1', 'm2'] as any,
      })

      expect(changeCallback).toBeDefined()
      changeCallback!(testDoc)

      expect(testDoc.name).toBe('New Name')
      expect(testDoc.notes.length).toBe(2)
      expect(testDoc.notes[0].id).toBe('n2')
      expect(testDoc.notes[1].id).toBe('n1')
      expect(testDoc.notes[1].text).toBe('Edited note')
      expect(testDoc.notes[1].archived).toBe(true)
      expect(testDoc.members).toEqual(['m1', 'm2'])
    })

    it('emits mutationFailed and itemUpdated when changeDocument returns false', async () => {
      changeDocumentMock.mockResolvedValue(false)
      const trueState = { id: itemId, text: 'old text' }
      getAutomergeItemMock.mockResolvedValue(trueState)

      await operations.mutateItem(itemId, changes)

      expect(markDocumentDirtyMock).not.toHaveBeenCalled()
      expect(emitMock).toHaveBeenCalledWith({
        type: 'mutationFailed',
        mutationType: 'edit',
        error: `Failed to update document ${itemId}`,
      })
      expect(getAutomergeItemMock).toHaveBeenCalledWith(itemId)
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: itemId,
        item: trueState,
      })
    })

    it('emits mutationFailed and itemUpdated when changeDocument throws', async () => {
      changeDocumentMock.mockRejectedValue(new Error('Doc update error'))
      const trueState = { id: itemId, text: 'old text' }
      getAutomergeItemMock.mockResolvedValue(trueState)

      await operations.mutateItem(itemId, changes)

      expect(markDocumentDirtyMock).not.toHaveBeenCalled()
      expect(emitMock).toHaveBeenCalledWith({
        type: 'mutationFailed',
        mutationType: 'edit',
        error: 'Doc update error',
      })
      expect(getAutomergeItemMock).toHaveBeenCalledWith(itemId)
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: itemId,
        item: trueState,
      })
    })
  })

  describe('storeItems', () => {
    it('handles successful items and thrown exceptions gracefully', async () => {
      const items = [
        { id: 'item-1' as ItemId, text: 'one' } as unknown as Item,
        { id: 'item-2' as ItemId, text: 'two' } as unknown as Item,
      ]

      changeDocumentMock.mockImplementation(async (id: ItemId) => {
        if (id === 'item-1') return true
        throw new Error('Disk failure')
      })
      getAutomergeItemMock.mockResolvedValue({ id: 'item-2' as ItemId, text: 'fallback' })

      await operations.storeItems(items)

      expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['item-1'])
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-1')
      expect(getAutomergeItemMock).toHaveBeenCalledWith('item-2')
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: 'item-2',
        item: { id: 'item-2', text: 'fallback' },
      })
    })

    it('removes deleted items from index and marks them dirty by default without adding to index', async () => {
      const items = [
        { id: 'item-del-1' as ItemId, deleted: true } as unknown as Item,
      ]

      changeDocumentMock.mockResolvedValue(true)

      await operations.storeItems(items)

      expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-del-1'])
      expect(addAutomergeItemIdsToIndexMock).not.toHaveBeenCalled()
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-del-1')
    })

    it('does not mark items dirty when markDirty: false is passed', async () => {
      const items = [
        { id: 'item-active' as ItemId, text: 'active note' } as unknown as Item,
        { id: 'item-del-1' as ItemId, deleted: true } as unknown as Item,
      ]

      changeDocumentMock.mockResolvedValue(true)

      await operations.storeItems(items, { markDirty: false })

      expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-del-1'])
      expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['item-active'])
      expect(markDocumentDirtyMock).not.toHaveBeenCalled()
    })

    it('handles mixed batch of active and deleted items appropriately by default', async () => {
      const items = [
        { id: 'item-active' as ItemId, text: 'active note' } as unknown as Item,
        { id: 'item-deleted' as ItemId, deleted: true } as unknown as Item,
      ]

      changeDocumentMock.mockResolvedValue(true)

      await operations.storeItems(items)

      expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-deleted'])
      expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['item-active'])
      expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith('account-1', ['item-active'])
      expect(markDocumentDirtyMock).toHaveBeenCalledTimes(2)
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-active')
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-deleted')
    })

    it('handles failed deleted items gracefully without modifying index', async () => {
      const items = [
        { id: 'item-del-fail' as ItemId, deleted: true } as unknown as Item,
      ]

      changeDocumentMock.mockResolvedValue(false)
      getAutomergeItemMock.mockResolvedValue({ id: 'item-del-fail' as ItemId, deleted: false })

      await operations.storeItems(items)

      expect(removeAutomergeItemIdsFromIndexMock).not.toHaveBeenCalled()
      expect(addAutomergeItemIdsToIndexMock).not.toHaveBeenCalled()
      expect(markDocumentDirtyMock).not.toHaveBeenCalled()
      expect(getAutomergeItemMock).toHaveBeenCalledWith('item-del-fail')
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: 'item-del-fail',
        item: { id: 'item-del-fail', deleted: false },
      })
    })
  })

  describe('compactItem', () => {
    it('compacts document, cleans up manual recovery, marks dirty, and emits updated item', async () => {
      const compactDocumentMock = vi.fn().mockResolvedValue(true)
      deps.docStore.compactDocument = compactDocumentMock
      const localItem = { id: 'item-1' as ItemId, type: 'note', text: 'survived content' } as unknown as Item
      getAutomergeItemMock.mockResolvedValue(localItem)

      await operations.compactItem('item-1' as ItemId)

      expect(getAutomergeItemMock).toHaveBeenCalledWith('item-1')
      expect(compactDocumentMock).toHaveBeenCalledWith('item-1', localItem)
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-1')
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: 'item-1',
        item: localItem,
      })
    })

    it('throws error if item is not found locally', async () => {
      getAutomergeItemMock.mockResolvedValue(null)

      await expect(operations.compactItem('missing-item' as ItemId)).rejects.toThrow('No local item found')
    })
  })

  describe('mutateMetadata', () => {
    it('updates index manager and pushes syncable metadata to server via apiClient when authenticated', async () => {
      const updatedMetadata = {
        prayerGoal: 10,
        defaultPrayerFrequency: { person: 'daily' as const },
        updatedAt: 12345,
      }
      deps.indexManager.updateAutomergeMetadata = vi.fn().mockResolvedValue(updatedMetadata)

      await operations.mutateMetadata({ prayerGoal: 10, defaultPrayerFrequency: { person: 'daily' } })

      expect(deps.indexManager.updateAutomergeMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          prayerGoal: 10,
          defaultPrayerFrequency: { person: 'daily' },
          updatedAt: expect.any(Number),
        }),
      )
      expect(mockApiClient.hasAuthToken).toHaveBeenCalled()
      expect(mockApiClient.updateAccountMetadata).toHaveBeenCalledWith({
        account: 'account-1',
        metadata: {
          prayerGoal: 10,
          defaultPrayerFrequency: { person: 'daily' },
          updatedAt: 12345,
        },
      })
    })

    it('does not push to server when only device-local sortCriteria is changed', async () => {
      const updatedMetadata = {
        sortCriteria: [{ type: 'name' as const, reverse: false }],
      }
      deps.indexManager.updateAutomergeMetadata = vi.fn().mockResolvedValue(updatedMetadata)

      await operations.mutateMetadata({ sortCriteria: [{ type: 'name', reverse: false }] })

      expect(deps.indexManager.updateAutomergeMetadata).toHaveBeenCalledWith({
        sortCriteria: [{ type: 'name', reverse: false }],
      })
      expect(mockApiClient.updateAccountMetadata).not.toHaveBeenCalled()
    })

    it('does not push to server when pushRemote is false', async () => {
      const updatedMetadata = { prayerGoal: 20, updatedAt: 555 }
      deps.indexManager.updateAutomergeMetadata = vi.fn().mockResolvedValue(updatedMetadata)

      await operations.mutateMetadata({ prayerGoal: 20 }, { pushRemote: false })

      expect(deps.indexManager.updateAutomergeMetadata).toHaveBeenCalled()
      expect(mockApiClient.updateAccountMetadata).not.toHaveBeenCalled()
    })

    it('does not push to server when apiClient reports no auth token', async () => {
      mockApiClient.hasAuthToken.mockResolvedValue(false)
      const updatedMetadata = { prayerGoal: 20, updatedAt: 555 }
      deps.indexManager.updateAutomergeMetadata = vi.fn().mockResolvedValue(updatedMetadata)

      await operations.mutateMetadata({ prayerGoal: 20 })

      expect(deps.indexManager.updateAutomergeMetadata).toHaveBeenCalled()
      expect(mockApiClient.hasAuthToken).toHaveBeenCalled()
      expect(mockApiClient.updateAccountMetadata).not.toHaveBeenCalled()
    })

    it('catches and warns on server push error from apiClient without throwing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockApiClient.updateAccountMetadata.mockRejectedValueOnce(new Error('Network error'))
      deps.indexManager.updateAutomergeMetadata = vi.fn().mockResolvedValue({ prayerGoal: 5 })

      await expect(operations.mutateMetadata({ prayerGoal: 5 })).resolves.not.toThrow()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to push metadata to server'),
        expect.any(Error),
      )
      warnSpy.mockRestore()
    })

    it('emits mutationFailed and rolls back metadata if updateAutomergeMetadata throws', async () => {
      deps.indexManager.updateAutomergeMetadata = vi.fn().mockRejectedValue(new Error('Storage failure'))
      deps.indexManager.getAutomergeMetadata = vi.fn().mockResolvedValue({ prayerGoal: 3 })

      await operations.mutateMetadata({ prayerGoal: 10 })

      expect(emitMock).toHaveBeenCalledWith({
        type: 'mutationFailed',
        mutationType: 'metadata',
        error: 'Storage failure',
      })
      expect(emitMock).toHaveBeenCalledWith({
        type: 'metadataUpdated',
        metadata: { prayerGoal: 3 },
      })
      expect(mockApiClient.updateAccountMetadata).not.toHaveBeenCalled()
    })

    it('defaults to constructing SyncApiClient when not provided in deps', () => {
      const ops = new ItemOperations({
        ...deps,
        apiClient: undefined,
      })
      expect((ops as any).apiClient).toBeInstanceOf(SyncApiClient)
    })
  })

  describe('recovery operations', () => {
    it('exposes recoveryManager instance directly', () => {
      expect(operations.recoveryManager).toBeDefined()
    })

    describe('forceOverwriteRecoveryItem', () => {
      it('throws if no local item is found', async () => {
        getAutomergeItemMock.mockResolvedValue(null)

        await expect(operations.forceOverwriteRecoveryItem('item-3' as ItemId)).rejects.toThrow(
          'No local item found for item-3. Force delete is available instead.'
        )
      })

      it('does nothing if accountId is not set', async () => {
        deps.accountId = ''

        await operations.forceOverwriteRecoveryItem('item-3' as ItemId)

        expect(getAutomergeItemMock).not.toHaveBeenCalled()
      })

      it('mutates the Automerge document to match local snapshot and clears recovery entry', async () => {
        const localItem = {
          id: 'item-3',
          type: 'person',
          name: 'Local Name',
          prayedFor: ['a', 'b'],
        }
        getAutomergeItemMock.mockResolvedValue(localItem)

        let capturedDoc: any = null
        changeDocumentMock.mockImplementation(
          async (itemId: ItemId, changeCallback: (doc: any) => void) => {
            capturedDoc = {}
            changeCallback(capturedDoc)
          }
        )

        const mockEntries: any[] = []
        mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

        await operations.forceOverwriteRecoveryItem('item-3' as ItemId)

        expect(getAutomergeItemMock).toHaveBeenCalledWith('item-3')
        expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-1', 'item-3')
        expect(changeDocumentMock).toHaveBeenCalledWith(
          'item-3',
          expect.any(Function),
          { createIfMissing: true }
        )
        expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['item-3'])
        expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith('account-1', ['item-3'])

        // Verify the document was mutated properly
        expect(capturedDoc).toEqual({
          id: 'item-3',
          type: 'person',
          name: 'Local Name',
          prayedFor: ['a', 'b'],
        })

        expect(emitMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
      })

      it('does not clear recovery state if changeDocument throws', async () => {
        const localItem = { id: 'item-3', type: 'person' }
        getAutomergeItemMock.mockResolvedValue(localItem)
        changeDocumentMock.mockRejectedValue(new Error('Change document failed'))

        await expect(
          operations.forceOverwriteRecoveryItem('item-3' as ItemId)
        ).rejects.toThrow('Change document failed')

        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      })
    })

    describe('forceDeleteRecoveryItem', () => {
      it('sets deleted to true on Automerge doc and removes recovery entry', async () => {
        let capturedDoc: any = null
        changeDocumentMock.mockImplementation(
          async (itemId: ItemId, changeCallback: (doc: any) => void) => {
            capturedDoc = {}
            changeCallback(capturedDoc)
          }
        )

        await operations.forceDeleteRecoveryItem('item-4' as ItemId)

        expect(changeDocumentMock).toHaveBeenCalledWith(
          'item-4',
          expect.any(Function),
          { createIfMissing: true }
        )
        expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-1', 'item-4')
        expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['item-4'])

        expect(capturedDoc).toEqual({
          id: 'item-4',
          deleted: true,
        })
      })

      it('does not clear recovery state if changeDocument throws', async () => {
        changeDocumentMock.mockRejectedValue(new Error('Change document failed'))

        await expect(
          operations.forceDeleteRecoveryItem('item-4' as ItemId)
        ).rejects.toThrow('Change document failed')

        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      })
    })

    describe('compactItem', () => {
      it('throws if no local item is found', async () => {
        getAutomergeItemMock.mockResolvedValue(null)

        await expect(operations.compactItem('item-5' as ItemId)).rejects.toThrow(
          'No local item found for item-5 to compact.'
        )
      })

      it('does nothing if accountId is not set', async () => {
        deps.accountId = ''

        await operations.compactItem('item-5' as ItemId)

        expect(getAutomergeItemMock).not.toHaveBeenCalled()
      })

      it('compacts document, clears recovery state, pushes recovery updates, and emits itemUpdated', async () => {
        const localItem = { id: 'item-5', type: 'note', text: 'hello' }
        getAutomergeItemMock.mockResolvedValue(localItem)
        compactDocumentMock.mockResolvedValue(undefined)
        const mockEntries: any[] = []
        mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

        operations.recoveryManager.setRecoveryCooldown('item-5' as ItemId, Date.now() + 10000)
        operations.recoveryManager.setInFlight('item-5' as ItemId, true)

        await operations.compactItem('item-5' as ItemId)

        expect(getAutomergeItemMock).toHaveBeenCalledWith('item-5')
        expect(compactDocumentMock).toHaveBeenCalledWith('item-5', localItem)
        expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-1', 'item-5')
        expect(operations.recoveryManager.isInFlight('item-5' as ItemId)).toBe(false)
        expect(operations.recoveryManager.getRecoveryCooldownUntil('item-5' as ItemId)).toBe(0)
        expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-5')
        expect(emitMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
        expect(emitMock).toHaveBeenCalledWith({ type: 'itemUpdated', id: 'item-5', item: localItem })
      })

      it('does not clear recovery state if compactDocument throws', async () => {
        const localItem = { id: 'item-5', type: 'note', text: 'hello' }
        getAutomergeItemMock.mockResolvedValue(localItem)
        compactDocumentMock.mockRejectedValue(new Error('Compact failed'))

        await expect(operations.compactItem('item-5' as ItemId)).rejects.toThrow('Compact failed')

        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      })
    })
  })
})

