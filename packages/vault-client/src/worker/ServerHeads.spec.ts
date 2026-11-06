import type { ItemId } from '@vault/shared'
import { ServerHeads } from './ServerHeads'

const ITEM_1 = 'item-1' as ItemId
const ITEM_2 = 'item-2' as ItemId

function createStore(initial: [ItemId, string[]][] = []) {
  let stored = initial
  return {
    loadSyncedHeads: vi.fn(async () => stored),
    saveSyncedHeads: vi.fn(async (entries: [ItemId, string[]][]) => {
      stored = entries
    }),
    get stored() {
      return stored
    },
  }
}

describe('ServerHeads', () => {
  it('has no heads for an item it has never seen', () => {
    const heads = new ServerHeads(createStore())

    expect(heads.get(ITEM_1)).toEqual([])
    expect(heads.has(ITEM_1)).toBe(false)
  })

  it('loads the stored heads', async () => {
    const heads = new ServerHeads(createStore([[ITEM_1, ['a']]]))

    await heads.load()

    expect(heads.get(ITEM_1)).toEqual(['a'])
  })

  it('writes only what this tab changed, so another tab\'s heads survive', async () => {
    const store = createStore([[ITEM_1, ['from another tab']]])
    const heads = new ServerHeads(store)

    heads.set(ITEM_2, ['mine'])
    await heads.save()

    expect(store.stored).toEqual([[ITEM_1, ['from another tab']], [ITEM_2, ['mine']]])
  })

  it('writes nothing when no heads changed', async () => {
    const store = createStore([[ITEM_1, ['a']]])
    const heads = new ServerHeads(store)
    await heads.load()

    heads.set(ITEM_1, ['a'])
    await heads.save()

    expect(store.saveSyncedHeads).not.toHaveBeenCalled()
  })

  it('keeps heads it has not saved across a reload', async () => {
    const heads = new ServerHeads(createStore([[ITEM_1, ['stored']]]))
    heads.set(ITEM_1, ['newer'])

    await heads.load()

    expect(heads.get(ITEM_1)).toEqual(['newer'])
    await heads.shutdown({ clearLocalData: true })
  })

  it('saves them again after a failed save', async () => {
    const store = createStore()
    store.saveSyncedHeads.mockRejectedValueOnce(new Error('quota'))
    const heads = new ServerHeads(store)
    heads.set(ITEM_1, ['a'])

    await heads.save()
    await heads.save()

    expect(store.stored).toEqual([[ITEM_1, ['a']]])
  })

  it('saves on shutdown, unless local data is being cleared', async () => {
    const store = createStore()
    const clearing = new ServerHeads(store)
    clearing.set(ITEM_1, ['a'])
    await clearing.shutdown({ clearLocalData: true })
    expect(store.saveSyncedHeads).not.toHaveBeenCalled()

    const stopping = new ServerHeads(store)
    stopping.set(ITEM_1, ['a'])
    await stopping.shutdown()
    expect(store.stored).toEqual([[ITEM_1, ['a']]])
  })
})
