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
const mockCompactDocument = vi.fn()

vi.mock('./docStore', () => ({
  AutomergeDocStore: vi.fn().mockImplementation(() => ({
    getAutomergeItem: mockGetAutomergeItem,
    changeDocument: mockChangeDocument,
    compactDocument: mockCompactDocument,
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
      compactDocument: mockCompactDocument,
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

  it('exposes recoveryManager instance directly', () => {
    expect(itemOperations.recoveryManager).toBeDefined()
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

    it('does not clear recovery state if changeDocument throws', async () => {
      const localItem = { id: 'item-3', type: 'person' }
      mockGetAutomergeItem.mockResolvedValue(localItem)
      mockChangeDocument.mockRejectedValue(new Error('Change document failed'))

      await expect(
        itemOperations.forceOverwriteRecoveryItem('item-3' as ItemId)
      ).rejects.toThrow('Change document failed')

      expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
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

      expect(mockChangeDocument).toHaveBeenCalledWith(
        'item-4',
        expect.any(Function),
        { createIfMissing: true }
      )
      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-4')
      expect(mockAddAutomergeItemIdsToIndex).toHaveBeenCalledWith(['item-4'])

      expect(capturedDoc).toEqual({
        id: 'item-4',
        deleted: true,
      })
    })

    it('does not clear recovery state if changeDocument throws', async () => {
      mockChangeDocument.mockRejectedValue(new Error('Change document failed'))

      await expect(
        itemOperations.forceDeleteRecoveryItem('item-4' as ItemId)
      ).rejects.toThrow('Change document failed')

      expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
    })
  })

  describe('compactItem', () => {
    it('throws if no local item is found', async () => {
      mockGetAutomergeItem.mockResolvedValue(null)

      await expect(itemOperations.compactItem('item-5' as ItemId)).rejects.toThrow(
        'No local item found for item-5 to compact.'
      )
    })

    it('does nothing if accountId is not set', async () => {
      depsObj.accountId = null

      await itemOperations.compactItem('item-5' as ItemId)

      expect(mockGetAutomergeItem).not.toHaveBeenCalled()
    })

    it('compacts document, clears recovery state, pushes recovery updates, and emits itemUpdated', async () => {
      const localItem = { id: 'item-5', type: 'note', text: 'hello' }
      mockGetAutomergeItem.mockResolvedValue(localItem)
      mockCompactDocument.mockResolvedValue(undefined)
      const mockEntries: any[] = []
      mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

      itemOperations.recoveryManager.setRecoveryCooldown('item-5' as ItemId, Date.now() + 10000)
      itemOperations.recoveryManager.setInFlight('item-5' as ItemId, true)

      await itemOperations.compactItem('item-5' as ItemId)

      expect(mockGetAutomergeItem).toHaveBeenCalledWith('item-5')
      expect(mockCompactDocument).toHaveBeenCalledWith('item-5', localItem)
      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-123', 'item-5')
      expect(itemOperations.recoveryManager.isInFlight('item-5' as ItemId)).toBe(false)
      expect(itemOperations.recoveryManager.getRecoveryCooldownUntil('item-5' as ItemId)).toBe(0)
      expect(depsObj.markDocumentDirty).toHaveBeenCalledWith('item-5')
      expect(onEventMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
      expect(onEventMock).toHaveBeenCalledWith({ type: 'itemUpdated', id: 'item-5', item: localItem })
    })

    it('does not clear recovery state if compactDocument throws', async () => {
      const localItem = { id: 'item-5', type: 'note', text: 'hello' }
      mockGetAutomergeItem.mockResolvedValue(localItem)
      mockCompactDocument.mockRejectedValue(new Error('Compact failed'))

      await expect(itemOperations.compactItem('item-5' as ItemId)).rejects.toThrow('Compact failed')

      expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
    })
  })
})
