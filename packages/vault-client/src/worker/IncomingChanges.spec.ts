import type { Mock } from 'vitest'
import type { ItemId } from '@vault/shared'
import { IncomingChanges, type IncomingChangesDeps } from './IncomingChanges'

type AnyMock = Mock<(...args: any[]) => any>

const ITEM = 'item-1' as ItemId
const SERVER_HEADS = ['a']
const HEADS_AFTER = ['b']

describe('IncomingChanges', () => {
  let outbox: { isPending: AnyMock; listPending: AnyMock }
  let itemSyncState: { getServerHeads: AnyMock; setServerHeads: AnyMock }
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
    const docStore = {
      applyIncomingChanges: vi.fn(async (_itemId: ItemId, _bytes: Uint8Array, onApplied?: (heads: { headsBefore: string[]; headsAfter: string[] }) => void) => {
        onApplied?.({ headsBefore: SERVER_HEADS, headsAfter: HEADS_AFTER })
        return { status: 'applied', addedChanges: true }
      }),
    }
    incoming = new IncomingChanges({
      docStore: docStore as unknown as IncomingChangesDeps['docStore'],
      marks: outbox,
      itemSyncState,
      onItemApplied: vi.fn(),
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
})
