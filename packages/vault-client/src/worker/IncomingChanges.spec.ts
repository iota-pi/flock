import type { Mock } from 'vitest'
import type { ItemId } from '@vault/shared'
import { IncomingChanges, type IncomingChangesDeps } from './IncomingChanges'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId
const DELETED = 'item-2' as ItemId
const SETTINGS = 'settings' as ItemId
const SERVER_HEADS = ['a']
const HEADS_AFTER = ['b']

describe('IncomingChanges', () => {
  let outbox: { isPending: AnyMock; listPending: AnyMock }
  let itemSyncState: { getServerHeads: AnyMock; setServerHeads: AnyMock }
  let docStore: { applyIncomingChanges: AnyMock; flushToStorage: AnyMock; getAutomergeItem: AnyMock }
  let indexManager: { addItemIds: AnyMock; removeItemIds: AnyMock }
  let incoming: IncomingChanges

  beforeEach(() => {
    outbox = {
      isPending: vi.fn().mockResolvedValue(false),
      listPending: vi.fn().mockResolvedValue([]),
    }
    itemSyncState = {
      getServerHeads: vi.fn().mockReturnValue(SERVER_HEADS),
      setServerHeads: vi.fn(),
    }
    docStore = {
      flushToStorage: vi.fn().mockResolvedValue(undefined),
      getAutomergeItem: vi.fn(async (itemId: ItemId) => ({ id: itemId })),
      applyIncomingChanges: vi.fn(async (_itemId: ItemId, _bytes: Uint8Array, onApplied?: (heads: { headsBefore: string[]; headsAfter: string[] }) => void) => {
        onApplied?.({ headsBefore: SERVER_HEADS, headsAfter: HEADS_AFTER })
        return { status: 'applied', addedChanges: true }
      }),
    }
    indexManager = {
      addItemIds: vi.fn().mockResolvedValue(undefined),
      removeItemIds: vi.fn().mockResolvedValue(undefined),
    }
    incoming = new IncomingChanges({
      docStore: docStore as unknown as IncomingChangesDeps['docStore'],
      indexManager,
      marks: outbox,
      itemSyncState,
      onItemApplied: vi.fn(),
      isUnindexed: itemId => itemId === SETTINGS,
    })
  })

  it('reads the pending marks as a set', async () => {
    outbox.listPending.mockResolvedValue([ITEM, ITEM])

    expect(await incoming.readPending()).toEqual(new Set([ITEM]))
  })

  it("uses a given set instead of reading the item's mark", async () => {
    await incoming.apply(ITEM, new Uint8Array(), new Set())

    expect(outbox.isPending).not.toHaveBeenCalled()
    expect(itemSyncState.setServerHeads).toHaveBeenCalledWith(ITEM, HEADS_AFTER)
  })

  it("doesn't move server heads for an item the given set marks pending", async () => {
    await incoming.apply(ITEM, new Uint8Array(), new Set([ITEM]))

    expect(itemSyncState.setServerHeads).not.toHaveBeenCalled()
  })

  it("reads the item's mark without a set", async () => {
    outbox.isPending.mockResolvedValue(true)

    await incoming.apply(ITEM, new Uint8Array())

    expect(outbox.isPending).toHaveBeenCalledWith(ITEM)
    expect(itemSyncState.setServerHeads).not.toHaveBeenCalled()
  })

  it('hands over the items whose docs gained changes once', async () => {
    await incoming.apply(ITEM, new Uint8Array(), new Set())

    expect(incoming.takeAddedChanges()).toEqual([ITEM])
    expect(incoming.takeAddedChanges()).toEqual([])
  })

  describe('indexApplied', () => {
    it('stores the applied docs, then indexes the live items and tombstones the deleted ones', async () => {
      docStore.getAutomergeItem.mockImplementation(async (itemId: ItemId) => ({ id: itemId, deleted: itemId === DELETED }))
      await incoming.apply(ITEM, new Uint8Array(), new Set())
      await incoming.apply(DELETED, new Uint8Array(), new Set())

      await incoming.indexApplied()

      expect(docStore.flushToStorage).toHaveBeenCalledWith([ITEM, DELETED])
      expect(indexManager.addItemIds).toHaveBeenCalledWith([ITEM])
      expect(indexManager.removeItemIds).toHaveBeenCalledWith([DELETED])
      expect(docStore.flushToStorage.mock.invocationCallOrder[0])
        .toBeLessThan(indexManager.addItemIds.mock.invocationCallOrder[0])
    })

    it('indexes each item once', async () => {
      await incoming.apply(ITEM, new Uint8Array(), new Set())
      await incoming.indexApplied()
      await incoming.indexApplied()

      expect(indexManager.addItemIds).toHaveBeenCalledTimes(1)
    })

    it('leaves out items kept out of the index, and items with missing dependencies', async () => {
      await incoming.apply(SETTINGS, new Uint8Array(), new Set())
      docStore.applyIncomingChanges.mockResolvedValueOnce({ status: 'missingDeps' })
      await incoming.apply(ITEM, new Uint8Array(), new Set())

      await incoming.indexApplied()

      expect(docStore.flushToStorage).not.toHaveBeenCalled()
      expect(indexManager.addItemIds).not.toHaveBeenCalled()
    })

    it("doesn't index an item whose doc failed to store, and keeps it for the next call", async () => {
      docStore.flushToStorage.mockRejectedValueOnce(new Error('disk full'))
      await incoming.apply(ITEM, new Uint8Array(), new Set())

      await expect(incoming.indexApplied()).rejects.toThrow('disk full')
      expect(indexManager.addItemIds).not.toHaveBeenCalled()

      await incoming.indexApplied()
      expect(indexManager.addItemIds).toHaveBeenCalledWith([ITEM])
    })

    it('runs one call at a time, so an older read never lists an item a newer one tombstoned', async () => {
      const liveRead = Promise.withResolvers<unknown>()
      docStore.getAutomergeItem.mockReturnValueOnce(liveRead.promise)
      await incoming.apply(ITEM, new Uint8Array(), new Set())
      const first = incoming.indexApplied()
      await vi.waitFor(() => expect(docStore.getAutomergeItem).toHaveBeenCalledTimes(1))

      docStore.getAutomergeItem.mockResolvedValue({ id: ITEM, deleted: true })
      await incoming.apply(ITEM, new Uint8Array(), new Set())
      const second = incoming.indexApplied()
      await new Promise(resolve => setTimeout(resolve, 0))
      liveRead.resolve({ id: ITEM })
      await Promise.all([first, second])

      expect(indexManager.addItemIds).toHaveBeenCalledTimes(1)
      expect(indexManager.removeItemIds.mock.invocationCallOrder[0])
        .toBeGreaterThan(indexManager.addItemIds.mock.invocationCallOrder[0])
    })
  })
})
