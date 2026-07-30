import { ItemId } from 'src/shared/schemas/items'
import { RecoveryManager } from './recoveryManager'
import { ClientEventHub } from './SyncEventHub'

// Mock dependencies
const mockReadManualRecoveryEntries = vi.fn()
const mockRemoveManualRecoveryEntryById = vi.fn()
const mockRemoveManualRecoveryEntryByItemId = vi.fn()

vi.mock('../shared/manualRecoveryStore', () => ({
  readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
  removeManualRecoveryEntryById: (...args: any[]) => mockRemoveManualRecoveryEntryById(...args),
  removeManualRecoveryEntryByItemId: (...args: any[]) => mockRemoveManualRecoveryEntryByItemId(...args),
}))

const mockGetAutomergeItem = vi.fn()
const mockChangeDocument = vi.fn()

vi.mock('./docStore', () => ({
  AutomergeDocStore: vi.fn().mockImplementation(() => ({
    getAutomergeItem: mockGetAutomergeItem,
    changeDocument: mockChangeDocument,
  }))
}))

const mockAddAutomergeItemIdsToIndex = vi.fn()
vi.mock('./docStore/AutomergeIndexManager', () => ({
  AutomergeIndexManager: vi.fn().mockImplementation(() => ({
    addAutomergeItemIdsToIndex: mockAddAutomergeItemIdsToIndex,
  }))
}))

describe('RecoveryManager', () => {
  let recoveryManager: RecoveryManager
  let eventHub: ClientEventHub
  let onEventMock: any
  let depsObj: { accountId: string | null; docStore: any; indexManager: any }

  beforeEach(() => {
    vi.clearAllMocks()

    eventHub = new ClientEventHub()
    onEventMock = vi.fn()
    eventHub.subscribe(onEventMock)

    const mockDocStore = {
      getAutomergeItem: mockGetAutomergeItem,
      changeDocument: mockChangeDocument,
    } as any

    const mockIndexManager = {
      addAutomergeItemIdsToIndex: mockAddAutomergeItemIdsToIndex,
    } as any

    depsObj = {
      accountId: 'account-123',
      docStore: mockDocStore,
      indexManager: mockIndexManager,
    }

    recoveryManager = new RecoveryManager(depsObj as any, eventHub)
  })

  describe('pushRecoveryItems', () => {
    it('fetches manual recovery entries and calls onRecoveryItemsChanged', async () => {
      const mockEntries = [{ id: 'entry-1', itemId: 'item-1', reason: 'error', createdAt: 12345 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.pushRecoveryItems()

      expect(mockReadManualRecoveryEntries).toHaveBeenCalledWith('account-123')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
    })

    it('does nothing if accountId is not set', async () => {
      depsObj.accountId = null

      await recoveryManager.pushRecoveryItems()

      expect(mockReadManualRecoveryEntries).not.toHaveBeenCalled()
    })

    it('handles error gracefully when push fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockReadManualRecoveryEntries.mockRejectedValue(new Error('Read failed'))

      await expect(recoveryManager.pushRecoveryItems()).resolves.toBeUndefined()
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe('retryRecoveryItem', () => {
    it('removes manual recovery entry by item ID and pushes updates', async () => {
      const mockEntries = [{ id: 'entry-2', itemId: 'item-2', reason: 'error2', createdAt: 67890 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.retryRecoveryItem('item-2' as ItemId)

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-2')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
    })
  })

  describe('forceOverwriteRecoveryItem', () => {
    it('throws if no local item is found', async () => {
      mockGetAutomergeItem.mockResolvedValue(null)

      await expect(recoveryManager.forceOverwriteRecoveryItem('item-3' as ItemId)).rejects.toThrow(
        'No local item found for item-3. Force delete is available instead.'
      )
    })

    it('does nothing if accountId is not set', async () => {
      depsObj.accountId = null

      await recoveryManager.forceOverwriteRecoveryItem('item-3' as ItemId)

      expect(mockGetAutomergeItem).not.toHaveBeenCalled()
    })

    it('mutates the Automerge document to match local snapshot and clears recovery entry', async () => {
      const localItem = {
        id: 'item-3',
        type: 'person',
        name: 'Local Name',
        prayedFor: ['a', 'b'],
      }
      mockGetAutomergeItem.mockResolvedValue(localItem)

      let capturedDoc: any = null
      mockChangeDocument.mockImplementation(
        async (itemId, changeCallback) => {
          capturedDoc = {}
          changeCallback(capturedDoc)
        }
      )

      const mockEntries: any[] = []
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.forceOverwriteRecoveryItem('item-3' as ItemId)

      expect(mockGetAutomergeItem).toHaveBeenCalledWith('item-3')
      expect(mockChangeDocument).toHaveBeenCalledWith(
        'item-3',
        expect.any(Function),
        { createIfMissing: true }
      )
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-3'])

      // Verify the document was mutated properly
      expect(capturedDoc).toEqual({
        id: 'item-3',
        type: 'person',
        name: 'Local Name',
        prayedFor: ['a', 'b'],
      })

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-3')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
    })
  })

  describe('forceDeleteRecoveryItem', () => {
    it('sets type to default person and deleted to true on Automerge doc', async () => {
      mockGetAutomergeItem.mockResolvedValue(null) // no existing type

      let capturedDoc: any = null
      mockChangeDocument.mockImplementation(
        async (itemId, changeCallback) => {
          capturedDoc = {}
          changeCallback(capturedDoc)
        }
      )

      await recoveryManager.forceDeleteRecoveryItem('item-4' as ItemId)

      expect(mockChangeDocument).toHaveBeenCalledWith(
        'item-4',
        expect.any(Function),
        { createIfMissing: true }
      )
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-4'])

      expect(capturedDoc).toEqual({
        id: 'item-4',
        type: 'person',
        deleted: true,
      })

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-4')
    })

    it('preserves existing item type when marking deleted', async () => {
      mockGetAutomergeItem.mockResolvedValue({ id: 'item-5', type: 'prayer' })

      let capturedDoc: any = null
      mockChangeDocument.mockImplementation(
        async (itemId, changeCallback) => {
          capturedDoc = {}
          changeCallback(capturedDoc)
        }
      )

      await recoveryManager.forceDeleteRecoveryItem('item-5' as ItemId)

      expect(capturedDoc).toEqual({
        id: 'item-5',
        type: 'prayer',
        deleted: true,
      })
    })
  })

  describe('dismissRecoveryItem', () => {
    it('removes manual recovery entry by entry ID and updates callbacks', async () => {
      await recoveryManager.dismissRecoveryItem('entry-123')

      expect(mockRemoveManualRecoveryEntryById).toHaveBeenCalledWith('account-123', 'entry-123')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: [] })
    })
  })

  describe('listRecoveryItems', () => {
    it('returns manual recovery entries', async () => {
      const mockEntries = [{ id: 'entry-99', itemId: 'item-99', reason: 'fail', createdAt: 0 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      const result = await recoveryManager.listRecoveryItems()
      expect(result).toBe(mockEntries)
    })
  })
})
