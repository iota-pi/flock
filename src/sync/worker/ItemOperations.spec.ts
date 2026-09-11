import { ItemOperations, ItemOperationsDeps } from './ItemOperations'
import type { Item } from '../../state/items'
import type { ItemId } from 'src/shared/schemas/items'

const mockPublishRealtimeBusSyncPing = vi.fn()
vi.mock('../client/realtimeBus', () => ({
  publishRealtimeBusSyncPing: (...args: any[]) => mockPublishRealtimeBusSyncPing(...args),
}))

const mockUpdateMetadataMutate = vi.fn().mockResolvedValue({ success: true })
const mockHasApiAuthToken = vi.fn().mockReturnValue(true)

vi.mock('../../api/runtime', () => ({
  hasApiAuthToken: () => mockHasApiAuthToken(),
}))

vi.mock('../../api/trpcClient', () => ({
  getTrpcClient: () => ({
    accounts: {
      updateMetadata: {
        mutate: mockUpdateMetadataMutate,
      },
    },
  }),
}))

describe('ItemOperations', () => {
  let deps: ItemOperationsDeps
  let operations: ItemOperations
  let emitMock: any
  let changeDocumentMock: any
  let addAutomergeItemIdsToIndexMock: any
  let removeAutomergeItemIdsFromIndexMock: any
  let markDocumentDirtyMock: any
  let getAutomergeItemMock: any

  beforeEach(() => {
    mockPublishRealtimeBusSyncPing.mockClear()
    mockUpdateMetadataMutate.mockClear()
    mockHasApiAuthToken.mockReturnValue(true)
    emitMock = vi.fn()
    changeDocumentMock = vi.fn()
    addAutomergeItemIdsToIndexMock = vi.fn()
    removeAutomergeItemIdsFromIndexMock = vi.fn().mockResolvedValue(undefined)
    markDocumentDirtyMock = vi.fn()
    getAutomergeItemMock = vi.fn()

    deps = {
      accountId: 'account-1',
      docStore: {
        changeDocument: changeDocumentMock,
        getAutomergeItem: getAutomergeItemMock,
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
      expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith(['item-1'])
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
      expect(mockPublishRealtimeBusSyncPing).toHaveBeenCalledWith(['item-active'])
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
    it('updates index manager and pushes syncable metadata to server when authenticated', async () => {
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
      expect(mockUpdateMetadataMutate).toHaveBeenCalledWith({
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
      expect(mockUpdateMetadataMutate).not.toHaveBeenCalled()
    })

    it('does not push to server when pushRemote is false', async () => {
      const updatedMetadata = { prayerGoal: 20, updatedAt: 555 }
      deps.indexManager.updateAutomergeMetadata = vi.fn().mockResolvedValue(updatedMetadata)

      await operations.mutateMetadata({ prayerGoal: 20 }, { pushRemote: false })

      expect(deps.indexManager.updateAutomergeMetadata).toHaveBeenCalled()
      expect(mockUpdateMetadataMutate).not.toHaveBeenCalled()
    })

    it('catches and warns on server push error without throwing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockUpdateMetadataMutate.mockRejectedValueOnce(new Error('Network error'))
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
      expect(mockUpdateMetadataMutate).not.toHaveBeenCalled()
    })
  })
})


