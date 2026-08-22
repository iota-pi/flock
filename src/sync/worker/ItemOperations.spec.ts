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

  describe('mutateItem', () => {
    const itemId = 'item-1' as ItemId
    const changes = { text: 'updated text' }

    it('marks document dirty when changeDocument succeeds', async () => {
      changeDocumentMock.mockResolvedValue(true)

      await operations.mutateItem(itemId, changes)

      expect(markDocumentDirtyMock).toHaveBeenCalledWith(itemId)
      expect(emitMock).not.toHaveBeenCalled()
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
  })
})

