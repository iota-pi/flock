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
})
