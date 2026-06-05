import { RecoveryManager } from './recoveryManager'

// Mock dependencies
const mockReadManualRecoveryEntries = vi.fn()
const mockRemoveManualRecoveryEntryById = vi.fn()
const mockRemoveManualRecoveryEntryByItemId = vi.fn()

vi.mock('../sync/manualRecoveryStore', () => ({
  readManualRecoveryEntries: () => mockReadManualRecoveryEntries(),
  removeManualRecoveryEntryById: (...args: any[]) => mockRemoveManualRecoveryEntryById(...args),
  removeManualRecoveryEntryByItemId: (...args: any[]) => mockRemoveManualRecoveryEntryByItemId(...args),
}))

const mockGetAutomergeItem = vi.fn()
const mockWithAutomergeDocumentChange = vi.fn()

vi.mock('../sync/docStore', () => ({
  getAutomergeItem: (...args: any[]) => mockGetAutomergeItem(...args),
  withAutomergeDocumentChange: (...args: any[]) => mockWithAutomergeDocumentChange(...args),
}))

describe('RecoveryManager', () => {
  let recoveryManager: RecoveryManager
  let mockCallbacks: { onRecoveryItemsChanged: any }
  let context: { accountId: string | null; callbacks: any }

  beforeEach(() => {
    vi.clearAllMocks()

    mockCallbacks = {
      onRecoveryItemsChanged: vi.fn(),
    }

    context = {
      accountId: 'account-123',
      callbacks: mockCallbacks,
    }

    recoveryManager = new RecoveryManager(() => context)
  })

  describe('pushRecoveryItems', () => {
    it('fetches manual recovery entries and calls onRecoveryItemsChanged', async () => {
      const mockEntries = [{ id: 'entry-1', itemId: 'item-1', reason: 'error', createdAt: 12345 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.pushRecoveryItems()

      expect(mockReadManualRecoveryEntries).toHaveBeenCalled()
      expect(mockCallbacks.onRecoveryItemsChanged).toHaveBeenCalledWith(mockEntries)
    })

    it('does nothing if callbacks are not set', async () => {
      context.callbacks = null

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

      await recoveryManager.retryRecoveryItem('item-2')

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('item-2')
      expect(mockCallbacks.onRecoveryItemsChanged).toHaveBeenCalledWith(mockEntries)
    })
  })

  describe('forceOverwriteRecoveryItem', () => {
    it('throws if no local item is found', async () => {
      mockGetAutomergeItem.mockResolvedValue(null)

      await expect(recoveryManager.forceOverwriteRecoveryItem('item-3')).rejects.toThrow(
        'No local item found for item-3. Force delete is available instead.'
      )
    })

    it('does nothing if accountId is not set', async () => {
      context.accountId = null

      await recoveryManager.forceOverwriteRecoveryItem('item-3')

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
      mockWithAutomergeDocumentChange.mockImplementation(
        async (accountId, itemId, changeCallback, options) => {
          capturedDoc = { ...options.initialValue }
          changeCallback(capturedDoc)
        }
      )

      const mockEntries: any[] = []
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await recoveryManager.forceOverwriteRecoveryItem('item-3')

      expect(mockGetAutomergeItem).toHaveBeenCalledWith('account-123', 'item-3')
      expect(mockWithAutomergeDocumentChange).toHaveBeenCalledWith(
        'account-123',
        'item-3',
        expect.any(Function),
        { createIfMissing: true, initialValue: { id: 'item-3' } }
      )

      // Verify the document was mutated properly
      expect(capturedDoc).toEqual({
        id: 'item-3',
        type: 'person',
        name: 'Local Name',
        prayedFor: ['a', 'b'],
      })

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('item-3')
      expect(mockCallbacks.onRecoveryItemsChanged).toHaveBeenCalledWith(mockEntries)
    })
  })

  describe('forceDeleteRecoveryItem', () => {
    it('sets type to default person and deleted to true on Automerge doc', async () => {
      mockGetAutomergeItem.mockResolvedValue(null) // no existing type

      let capturedDoc: any = null
      mockWithAutomergeDocumentChange.mockImplementation(
        async (accountId, itemId, changeCallback, options) => {
          capturedDoc = { ...options.initialValue }
          changeCallback(capturedDoc)
        }
      )

      await recoveryManager.forceDeleteRecoveryItem('item-4')

      expect(mockWithAutomergeDocumentChange).toHaveBeenCalledWith(
        'account-123',
        'item-4',
        expect.any(Function),
        { createIfMissing: true, initialValue: { id: 'item-4' } }
      )

      expect(capturedDoc).toEqual({
        id: 'item-4',
        type: 'person',
        deleted: true,
      })

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('item-4')
    })

    it('preserves existing item type when marking deleted', async () => {
      mockGetAutomergeItem.mockResolvedValue({ id: 'item-5', type: 'prayer' })

      let capturedDoc: any = null
      mockWithAutomergeDocumentChange.mockImplementation(
        async (accountId, itemId, changeCallback, options) => {
          capturedDoc = { ...options.initialValue }
          changeCallback(capturedDoc)
        }
      )

      await recoveryManager.forceDeleteRecoveryItem('item-5')

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

      expect(mockRemoveManualRecoveryEntryById).toHaveBeenCalledWith('entry-123')
      expect(mockCallbacks.onRecoveryItemsChanged).toHaveBeenCalled()
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
