import { ItemOperations, ItemOperationsDeps } from './ItemOperations'
import type { VaultDoc } from '../shared/types'
import { passthroughCodec } from './domain'
import { settingsDocId, type ItemId } from '@vault/shared'
import { MAX_ITEM_CONTENT_BYTES, MAX_ITEM_CONTENT_KB } from '@vault/shared'

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
  let emitMock: any
  let changeDocumentMock: any
  let addAutomergeItemIdsToIndexMock: any
  let removeAutomergeItemIdsFromIndexMock: any
  let markDocumentDirtyMock: any
  let getAutomergeItemMock: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockPublishRealtimeBusSyncPing.mockClear()
    mockReadManualRecoveryEntries.mockResolvedValue([])
    mockReadManualRecoveryCount.mockResolvedValue(0)
    mockRemoveManualRecoveryEntryById.mockResolvedValue(undefined)
    mockRemoveManualRecoveryEntryByItemId.mockResolvedValue(undefined)
    mockUpsertManualRecoveryEntry.mockResolvedValue(undefined)
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
        codec: { ...passthroughCodec, isCorrupt: (doc: VaultDoc) => doc.type === 'error' },
      } as any,
      indexManager: {
        addAutomergeItemIdsToIndex: addAutomergeItemIdsToIndexMock,
        listAutomergeItemIds: vi.fn().mockResolvedValue([]),
        removeAutomergeItemIdsFromIndex: removeAutomergeItemIdsFromIndexMock,
      } as any,
      eventHub: {
        emit: emitMock,
      } as any,
      markDocumentDirty: markDocumentDirtyMock,
    }

    operations = new ItemOperations(deps)
  })

  describe('createItem', () => {
    const testItem = { id: 'item-1' as ItemId, type: 'note', text: 'hello' } as unknown as VaultDoc

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
        { id: 'item-1' as ItemId, text: 'one' } as unknown as VaultDoc,
        { id: 'item-2' as ItemId, text: 'two' } as unknown as VaultDoc,
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
        { id: 'item-del-1' as ItemId, deleted: true } as unknown as VaultDoc,
      ]

      changeDocumentMock.mockResolvedValue(true)

      await operations.storeItems(items)

      expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-del-1'])
      expect(addAutomergeItemIdsToIndexMock).not.toHaveBeenCalled()
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-del-1')
    })

    it('does not mark items dirty when markDirty: false is passed', async () => {
      const items = [
        { id: 'item-active' as ItemId, text: 'active note' } as unknown as VaultDoc,
        { id: 'item-del-1' as ItemId, deleted: true } as unknown as VaultDoc,
      ]

      changeDocumentMock.mockResolvedValue(true)

      await operations.storeItems(items, { markDirty: false })

      expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-del-1'])
      expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith(['item-active'])
      expect(markDocumentDirtyMock).not.toHaveBeenCalled()
    })

    it('handles mixed batch of active and deleted items appropriately by default', async () => {
      const items = [
        { id: 'item-active' as ItemId, text: 'active note' } as unknown as VaultDoc,
        { id: 'item-deleted' as ItemId, deleted: true } as unknown as VaultDoc,
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
        { id: 'item-del-fail' as ItemId, deleted: true } as unknown as VaultDoc,
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

  describe('recreateOversizedItem', () => {
    it('creates new document with clean history, soft-deletes old item, unquarantines, and returns new ID', async () => {
      changeDocumentMock.mockResolvedValue(true)
      const localItem = { id: 'item-1' as ItemId, type: 'note', text: 'survived content' } as unknown as VaultDoc
      getAutomergeItemMock.mockResolvedValue(localItem)

      const newItemId = await operations.recreateOversizedItem('item-1' as ItemId)

      expect(typeof newItemId).toBe('string')
      expect(newItemId).not.toBe('item-1')
      expect(getAutomergeItemMock).toHaveBeenCalledWith('item-1')
      expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith([newItemId])
      expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-1'])
      expect(markDocumentDirtyMock).toHaveBeenCalledWith(newItemId)
      expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-1')
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: 'item-1',
        item: null,
      })
      expect(emitMock).toHaveBeenCalledWith({
        type: 'itemUpdated',
        id: newItemId,
        item: expect.objectContaining({ id: newItemId, text: 'survived content' }),
      })
    })

    it('throws error if item is not found locally', async () => {
      getAutomergeItemMock.mockResolvedValue(null)

      await expect(operations.recreateOversizedItem('missing-item' as ItemId)).rejects.toThrow('No local item found')
    })

    it(`throws error if content size alone exceeds ${MAX_ITEM_CONTENT_KB} KB`, async () => {
      const hugeItem = { id: 'item-huge' as ItemId, type: 'note', text: 'x'.repeat(MAX_ITEM_CONTENT_BYTES + 5 * 1024) } as unknown as VaultDoc
      getAutomergeItemMock.mockResolvedValue(hugeItem)

      await expect(operations.recreateOversizedItem('item-huge' as ItemId)).rejects.toThrow(`over ${MAX_ITEM_CONTENT_KB} KB`)
    })
  })

  describe('settings document', () => {
    const settingsId = settingsDocId('account-1')

    it('refuses to force-delete the settings document', async () => {
      await expect(operations.forceDeleteRecoveryItem(settingsId)).rejects.toThrow('account settings document')
      expect(changeDocumentMock).not.toHaveBeenCalled()
    })

    it('refuses to recreate the settings document under a new ID', async () => {
      getAutomergeItemMock.mockResolvedValue({ id: settingsId, prayerGoal: 3 })

      await expect(operations.recreateOversizedItem(settingsId)).rejects.toThrow('account settings document')
      expect(changeDocumentMock).not.toHaveBeenCalled()
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

      it('throws if local item has error type (validation failed)', async () => {
        getAutomergeItemMock.mockResolvedValue({
          id: 'item-3' as ItemId,
          type: 'error',
          name: 'Corrupt Item',
          description: 'This item could not be parsed.',
        })

        await expect(operations.forceOverwriteRecoveryItem('item-3' as ItemId)).rejects.toThrow(
          'Cannot overwrite with corrupt local item item-3. Force delete is available instead.'
        )

        expect(changeDocumentMock).not.toHaveBeenCalled()
        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
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
        expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-3')
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
        expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-4'])
        expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-4')

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

    describe('recreateOversizedItem', () => {
      it('throws if no local item is found', async () => {
        getAutomergeItemMock.mockResolvedValue(null)

        await expect(operations.recreateOversizedItem('item-5' as ItemId)).rejects.toThrow(
          'No local item found for item-5 to recreate.'
        )
      })

      it('throws if accountId is not set', async () => {
        deps.accountId = ''

        await expect(operations.recreateOversizedItem('item-5' as ItemId)).rejects.toThrow(
          'Account ID is required to recreate oversized item.'
        )
      })

      it('recreates document, remaps references, clears recovery state, and emits updates', async () => {
        const remapReferences = vi.fn((doc: VaultDoc, oldId: ItemId, newId: ItemId) => (
          Array.isArray(doc.members) && doc.members.includes(oldId)
            ? { members: doc.members.map(member => (member === oldId ? newId : member)) }
            : null
        ))
        const prepareRecreatedDoc = vi.fn((doc: VaultDoc) => ({ ...doc, recreated: true }))
        operations = new ItemOperations({ ...deps, hooks: { remapReferences, prepareRecreatedDoc } })
        changeDocumentMock.mockResolvedValue(true)
        const localItem = { id: 'item-5', type: 'note', text: 'hello' }
        getAutomergeItemMock.mockImplementation(async (id: string) => {
          if (id === 'item-5') return localItem
          if (id === 'group-1') return { id: 'group-1', type: 'group', members: ['item-5', 'other-item'] }
          return null
        })
        deps.indexManager.listAutomergeItemIds = vi.fn().mockResolvedValue(['group-1'])
        const mockEntries: any[] = []
        mockReadManualRecoveryEntries.mockResolvedValue(mockEntries)

        operations.recoveryManager.setRecoveryCooldown('item-5' as ItemId, Date.now() + 10000)
        operations.recoveryManager.setInFlight('item-5' as ItemId, true)

        const newItemId = await operations.recreateOversizedItem('item-5' as ItemId)

        expect(typeof newItemId).toBe('string')
        expect(newItemId).not.toBe('item-5')
        expect(getAutomergeItemMock).toHaveBeenCalledWith('item-5')
        expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-1', 'item-5')
        expect(operations.recoveryManager.isInFlight('item-5' as ItemId)).toBe(false)
        expect(operations.recoveryManager.getRecoveryCooldownUntil('item-5' as ItemId)).toBe(0)
        expect(markDocumentDirtyMock).toHaveBeenCalledWith(newItemId)
        expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-5')
        expect(emitMock).toHaveBeenCalledWith({ type: 'recoveryItemsChanged', entries: mockEntries })
        expect(emitMock).toHaveBeenCalledWith({ type: 'itemUpdated', id: 'item-5', item: null })
        expect(emitMock).toHaveBeenCalledWith({
          type: 'itemUpdated',
          id: newItemId,
          item: expect.objectContaining({ id: newItemId, text: 'hello', recreated: true }),
        })
        expect(remapReferences).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'group-1' }),
          'item-5',
          newItemId,
        )
        expect(changeDocumentMock).toHaveBeenCalledWith('group-1', expect.any(Function), { knownToExist: true })
        expect(markDocumentDirtyMock).toHaveBeenCalledWith('group-1')
      })

      it('does not clear recovery state if item creation throws', async () => {
        const localItem = { id: 'item-5', type: 'note', text: 'hello' }
        getAutomergeItemMock.mockResolvedValue(localItem)
        changeDocumentMock.mockImplementation(async (id: string) => {
          if (id !== 'item-5') throw new Error('Creation failed')
          return true
        })

        await expect(operations.recreateOversizedItem('item-5' as ItemId)).rejects.toThrow('Creation failed')

        expect(changeDocumentMock).not.toHaveBeenCalledWith('item-5', expect.anything(), expect.anything())
        expect(removeAutomergeItemIdsFromIndexMock).not.toHaveBeenCalled()
        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      })

      it('does not delete or unquarantine the old item when the new document cannot be created', async () => {
        getAutomergeItemMock.mockResolvedValue({ id: 'item-1', type: 'note', text: 'hello' })
        changeDocumentMock.mockImplementation(async (id: string) => id === 'item-1')

        await expect(operations.recreateOversizedItem('item-1' as ItemId)).rejects.toThrow('Failed to recreate')

        expect(changeDocumentMock).not.toHaveBeenCalledWith('item-1', expect.anything(), expect.anything())
        expect(removeAutomergeItemIdsFromIndexMock).not.toHaveBeenCalled()
        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
        expect(markDocumentDirtyMock).not.toHaveBeenCalledWith('item-1')
      })

      it('retires the new document and leaves the old item untouched when indexing fails', async () => {
        getAutomergeItemMock.mockResolvedValue({ id: 'item-1', type: 'note', text: 'hello' })
        changeDocumentMock.mockResolvedValue(true)
        addAutomergeItemIdsToIndexMock.mockRejectedValue(new Error('Index failed'))

        await expect(operations.recreateOversizedItem('item-1' as ItemId)).rejects.toThrow('Index failed')

        expect(changeDocumentMock).not.toHaveBeenCalledWith('item-1', expect.anything(), expect.anything())
        const newId = changeDocumentMock.mock.calls[0][0]
        expect(newId).not.toBe('item-1')
        expect(changeDocumentMock).toHaveBeenCalledTimes(2)
        expect(changeDocumentMock).toHaveBeenLastCalledWith(newId, expect.any(Function), { knownToExist: true })
        expect(removeAutomergeItemIdsFromIndexMock).not.toHaveBeenCalled()
        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      })

      it('finalises a previous recreation without creating a new item when the source is already deleted', async () => {
        getAutomergeItemMock.mockResolvedValue({ id: 'item-1', type: 'note', deleted: true })

        const result = await operations.recreateOversizedItem('item-1' as ItemId)

        expect(result).toBe('item-1')
        expect(changeDocumentMock).not.toHaveBeenCalled()
        expect(addAutomergeItemIdsToIndexMock).not.toHaveBeenCalled()
        expect(removeAutomergeItemIdsFromIndexMock).toHaveBeenCalledWith(['item-1'])
        expect(markDocumentDirtyMock).toHaveBeenCalledWith('item-1')
        expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('account-1', 'item-1')
        expect(emitMock).toHaveBeenCalledWith({ type: 'itemUpdated', id: 'item-1', item: null })
      })

      it('merges concurrent calls for the same item into one recreation', async () => {
        getAutomergeItemMock.mockResolvedValue({ id: 'item-1', type: 'note', text: 'hello' })
        changeDocumentMock.mockResolvedValue(true)

        const [first, second] = await Promise.all([
          operations.recreateOversizedItem('item-1' as ItemId),
          operations.recreateOversizedItem('item-1' as ItemId),
        ])

        expect(first).toBe(second)
        expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledTimes(1)
        expect(addAutomergeItemIdsToIndexMock).toHaveBeenCalledWith([first])
      })

      it('does not remove the old item from the index when it cannot be marked deleted', async () => {
        getAutomergeItemMock.mockResolvedValue({ id: 'item-1', type: 'note', text: 'hello' })
        changeDocumentMock.mockImplementation(async (id: string) => id !== 'item-1')

        await expect(operations.recreateOversizedItem('item-1' as ItemId)).rejects.toThrow(
          'could not be marked deleted',
        )

        expect(removeAutomergeItemIdsFromIndexMock).not.toHaveBeenCalled()
        expect(mockRemoveManualRecoveryEntryByItemId).not.toHaveBeenCalled()
      })
    })
  })
})

