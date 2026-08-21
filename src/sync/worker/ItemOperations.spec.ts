import { ItemOperations, ItemOperationsDeps } from './ItemOperations'
import type { Item } from '../../state/items'
import type { ItemId } from 'src/shared/schemas/items'

describe('ItemOperations', () => {
  let deps: ItemOperationsDeps
  let operations: ItemOperations
  let emitMock: any
  let changeDocumentMock: any
  let addAutomergeItemIdsToIndexMock: any
  let markDocumentDirtyMock: any
  let getAutomergeItemMock: any

  beforeEach(() => {
    emitMock = vi.fn()
    changeDocumentMock = vi.fn()
    addAutomergeItemIdsToIndexMock = vi.fn()
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
        removeAutomergeItemIdsFromIndex: vi.fn().mockResolvedValue(undefined),
        updateAutomergeMetadata: vi.fn(),
        getAutomergeMetadata: vi.fn(),
      } as any,
      eventHub: {
        emit: emitMock,
      } as any,
      markDocumentDirty: markDocumentDirtyMock,
      deletionQueueManager: {
        cancelDeletion: vi.fn().mockResolvedValue(undefined),
      } as any,
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

  describe('hardDeleteItems', () => {
    it('deletes items, removes from index, and cancels scheduled deletions', async () => {
      await operations.hardDeleteItems(['item-1' as ItemId, 'item-2' as ItemId])

      expect(deps.docStore.removeAutomergeItem).toHaveBeenCalledWith('item-1')
      expect(deps.docStore.removeAutomergeItem).toHaveBeenCalledWith('item-2')
      expect(deps.indexManager.removeAutomergeItemIdsFromIndex).toHaveBeenCalledWith(['item-1', 'item-2'])
      expect(deps.deletionQueueManager.cancelDeletion).toHaveBeenCalledWith('item-1')
      expect(deps.deletionQueueManager.cancelDeletion).toHaveBeenCalledWith('item-2')
      expect(emitMock).not.toHaveBeenCalled()
    })

    it('continues processing remaining items and retains deletion queue entry for failed items when partial failure occurs', async () => {
      const removeMock = deps.docStore.removeAutomergeItem as any
      removeMock.mockImplementation(async (id: ItemId) => {
        if (id === 'item-2') {
          throw new Error('Failed to delete item-2')
        }
      })

      await operations.hardDeleteItems(['item-1' as ItemId, 'item-2' as ItemId, 'item-3' as ItemId])

      // All items were attempted
      expect(deps.docStore.removeAutomergeItem).toHaveBeenCalledWith('item-1')
      expect(deps.docStore.removeAutomergeItem).toHaveBeenCalledWith('item-2')
      expect(deps.docStore.removeAutomergeItem).toHaveBeenCalledWith('item-3')

      // Only successfully deleted items are removed from index
      expect(deps.indexManager.removeAutomergeItemIdsFromIndex).toHaveBeenCalledWith(['item-1', 'item-3'])

      // Only successfully deleted items have scheduled deletions cancelled
      expect(deps.deletionQueueManager.cancelDeletion).toHaveBeenCalledWith('item-1')
      expect(deps.deletionQueueManager.cancelDeletion).toHaveBeenCalledWith('item-3')
      expect(deps.deletionQueueManager.cancelDeletion).not.toHaveBeenCalledWith('item-2')

      // Emits mutationFailed for the failed item
      expect(emitMock).toHaveBeenCalledWith({
        type: 'mutationFailed',
        mutationType: 'hardDelete',
        error: 'Failed to delete item-2',
      })
    })
  })
})
