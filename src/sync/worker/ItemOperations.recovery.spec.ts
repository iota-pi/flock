import { ItemId } from 'src/shared/schemas/items'
import { ItemOperations } from './ItemOperations'
import { ClientEventHub } from './SyncEventHub'

// Mock dependencies
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

describe('ItemOperations - Recovery', () => {
  let itemOperations: ItemOperations
  let eventHub: ClientEventHub
  let onEventMock: any
  let depsObj: { accountId: string | null; docStore: any; indexManager: any; eventHub: any; markDocumentDirty: any }

  beforeEach(() => {
    vi.resetAllMocks()

    eventHub = new ClientEventHub()
    onEventMock = vi.fn()
    eventHub.subscribe(onEventMock)

    mockReadManualRecoveryEntries.mockResolvedValue([])
    mockReadManualRecoveryCount.mockResolvedValue(0)
    mockRemoveManualRecoveryEntryById.mockResolvedValue(undefined)
    mockRemoveManualRecoveryEntryByItemId.mockResolvedValue(undefined)
    mockUpsertManualRecoveryEntry.mockResolvedValue(undefined)

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
      eventHub,
      markDocumentDirty: vi.fn(),
    }

    itemOperations = new ItemOperations(depsObj as any)
  })

  describe('pushRecoveryItems', () => {
    it('fetches manual recovery entries and calls onRecoveryItemsChanged', async () => {
      const mockEntries = [{ id: 'entry-1', itemId: 'item-1', reason: 'error', createdAt: 12345 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await itemOperations.pushRecoveryItems()

      expect(mockReadManualRecoveryEntries).toHaveBeenCalledWith('account-123')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
    })

    it('does nothing if accountId is not set', async () => {
      depsObj.accountId = null

      await itemOperations.pushRecoveryItems()

      expect(mockReadManualRecoveryEntries).not.toHaveBeenCalled()
    })

    it('handles error gracefully when push fails', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      mockReadManualRecoveryEntries.mockRejectedValue(new Error('Read failed'))

      await expect(itemOperations.pushRecoveryItems()).resolves.toBeUndefined()
      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe('retryRecoveryItem', () => {
    it('removes manual recovery entry by item ID and pushes updates', async () => {
      const mockEntries = [{ id: 'entry-2', itemId: 'item-2', reason: 'error2', createdAt: 67890 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await itemOperations.retryRecoveryItem('item-2' as ItemId)

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-2')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
    })
  })

  describe('forceOverwriteRecoveryItem', () => {
    it('throws if no local item is found', async () => {
      mockGetAutomergeItem.mockResolvedValue(null)

      await expect(itemOperations.forceOverwriteRecoveryItem('item-3' as ItemId)).rejects.toThrow(
        'No local item found for item-3. Force delete is available instead.'
      )
    })

    it('does nothing if accountId is not set', async () => {
      depsObj.accountId = null

      await itemOperations.forceOverwriteRecoveryItem('item-3' as ItemId)

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

      await itemOperations.forceOverwriteRecoveryItem('item-3' as ItemId)

      expect(mockGetAutomergeItem).toHaveBeenCalledWith('item-3')
      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-3')
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

      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
    })

    it('does not mutate document if removeManualRecoveryEntryByItemId fails', async () => {
      const localItem = { id: 'item-3', type: 'person' }
      mockGetAutomergeItem.mockResolvedValue(localItem)
      mockRemoveManualRecoveryEntryByItemId.mockRejectedValue(new Error('Deletion failed'))

      await expect(
        itemOperations.forceOverwriteRecoveryItem('item-3' as ItemId)
      ).rejects.toThrow('Deletion failed')

      expect(mockChangeDocument).not.toHaveBeenCalled()
    })
  })

  describe('forceDeleteRecoveryItem', () => {
    it('sets deleted to true on Automerge doc and removes recovery entry', async () => {
      let capturedDoc: any = null
      mockChangeDocument.mockImplementation(
        async (itemId, changeCallback) => {
          capturedDoc = {}
          changeCallback(capturedDoc)
        }
      )

      await itemOperations.forceDeleteRecoveryItem('item-4' as ItemId)

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-4')
      expect(mockChangeDocument).toHaveBeenCalledWith(
        'item-4',
        expect.any(Function),
        { createIfMissing: true }
      )
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-4'])

      expect(capturedDoc).toEqual({
        id: 'item-4',
        deleted: true,
      })
    })

    it('does not mutate document if removeManualRecoveryEntryByItemId fails', async () => {
      mockRemoveManualRecoveryEntryByItemId.mockRejectedValue(new Error('Deletion failed'))

      await expect(
        itemOperations.forceDeleteRecoveryItem('item-4' as ItemId)
      ).rejects.toThrow('Deletion failed')

      expect(mockChangeDocument).not.toHaveBeenCalled()
    })
  })

  describe('dismissRecoveryItem', () => {
    it('removes manual recovery entry by entry ID and updates callbacks', async () => {
      await itemOperations.dismissRecoveryItem('entry-123')

      expect(mockRemoveManualRecoveryEntryById).toHaveBeenCalledWith('account-123', 'entry-123')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: [] })
    })
  })

  describe('tracking & cooldowns', () => {
    it('manages in-flight tracking correctly', () => {
      expect(itemOperations.isInFlight('item-1' as ItemId)).toBe(false)
      itemOperations.setInFlight('item-1' as ItemId, true)
      expect(itemOperations.isInFlight('item-1' as ItemId)).toBe(true)
      itemOperations.setInFlight('item-1' as ItemId, false)
      expect(itemOperations.isInFlight('item-1' as ItemId)).toBe(false)
    })

    it('manages and lazily cleans up expired cooldowns', () => {
      vi.useFakeTimers()
      const now = Date.now()
      itemOperations.setRecoveryCooldown('item-1' as ItemId, now + 1000)
      expect(itemOperations.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(now + 1000)

      vi.advanceTimersByTime(1500)
      expect(itemOperations.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
      vi.useRealTimers()
    })

    it('clears cooldown and resets state', () => {
      itemOperations.setRecoveryCooldown('item-1' as ItemId, Date.now() + 10000)
      itemOperations.setInFlight('item-1' as ItemId, true)
      itemOperations.clearRecoveryCooldown('item-1' as ItemId)
      expect(itemOperations.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)

      itemOperations.reset()
      expect(itemOperations.isInFlight('item-1' as ItemId)).toBe(false)
    })
  })

  describe('reportDecryptionFailure and attemptAutoRecovery', () => {
    it('creates manual recovery entry and emits recoveryItemsChanged', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockEntries = [{ id: 'entry-1', itemId: 'item-1', reason: 'fail', createdAt: 1 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      await itemOperations.reportDecryptionFailure('item-1' as ItemId, new Error('bad decrypt'))

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'Automated recovery is unavailable for this revision',
      })
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
      consoleSpy.mockRestore()
    })

    it('includes failed branches hint when available', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await itemOperations.reportDecryptionFailure(
        'item-1' as ItemId,
        new Error('bad decrypt'),
        ['branch-A', 'branch-B']
      )

      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith('account-123', {
        itemId: 'item-1',
        reason: 'Corrupted branches: branch-A, branch-B',
      })
      consoleSpy.mockRestore()
    })

    it('suppresses duplicate recovery triggers while in-flight or on cooldown', async () => {
      vi.useFakeTimers()
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await itemOperations.reportDecryptionFailure('item-1' as ItemId, new Error('fail 1'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      // Immediate second call should be blocked by cooldown
      await itemOperations.reportDecryptionFailure('item-1' as ItemId, new Error('fail 2'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      // Advance past 60s cooldown
      vi.advanceTimersByTime(61 * 1000)

      await itemOperations.reportDecryptionFailure('item-1' as ItemId, new Error('fail 3'))
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(2)

      consoleSpy.mockRestore()
      vi.useRealTimers()
    })

    it('does nothing if accountId or itemId is not set', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await itemOperations.reportDecryptionFailure('' as ItemId, new Error('fail'))
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()

      depsObj.accountId = null
      await itemOperations.reportDecryptionFailure('item-1' as ItemId, new Error('fail'))
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  describe('clearManualRecoveryForItems', () => {
    it('removes recovery entries, clears cooldowns, and emits recoveryItemsChanged', async () => {
      itemOperations.setRecoveryCooldown('item-1' as ItemId, Date.now() + 50000)
      itemOperations.setInFlight('item-1' as ItemId, true)
      mockReadManualRecoveryCount
        .mockResolvedValueOnce(1) // previousCount
        .mockResolvedValueOnce(0) // nextCount

      await itemOperations.clearManualRecoveryForItems(['item-1' as ItemId])

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-1')
      expect(itemOperations.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
      expect(itemOperations.isInFlight('item-1' as ItemId)).toBe(false)
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: [] })
    })

    it('clears cooldown and in-flight even if previousCount is 0 without calling removeManualRecoveryEntryByItemId', async () => {
      itemOperations.setRecoveryCooldown('item-1' as ItemId, Date.now() + 50000)
      itemOperations.setInFlight('item-1' as ItemId, true)
      mockReadManualRecoveryCount.mockResolvedValue(0)

      await itemOperations.clearManualRecoveryForItems(['item-1' as ItemId])

      expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      expect(itemOperations.getRecoveryCooldownUntil('item-1' as ItemId)).toBe(0)
      expect(itemOperations.isInFlight('item-1' as ItemId)).toBe(false)
    })

    it('returns early when itemIds array is empty or accountId is missing', async () => {
      await itemOperations.clearManualRecoveryForItems([])
      expect(mockReadManualRecoveryCount).not.toHaveBeenCalled()

      depsObj.accountId = null
      await itemOperations.clearManualRecoveryForItems(['item-1' as ItemId])
      expect(mockReadManualRecoveryCount).not.toHaveBeenCalled()
    })
  })

  describe('listRecoveryItems', () => {
    it('returns manual recovery entries', async () => {
      const mockEntries = [{ id: 'entry-99', itemId: 'item-99', reason: 'fail', createdAt: 0 }]
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      const result = await itemOperations.listRecoveryItems()
      expect(result).toBe(mockEntries)
    })
  })
})
