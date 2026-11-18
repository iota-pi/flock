import { IDBFactory } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { ServerHeads } from './ServerHeads'
import { SyncLogDatabase } from './stores/SyncLogDatabase'
import { SYNC_LOG_STORES } from '../shared/syncLogStorage'
import type { ItemSyncRecord } from './stores/itemSyncRecords'

const ITEM_1 = 'item-1' as ItemId
const ITEM_2 = 'item-2' as ItemId

describe('ServerHeads', () => {
  let db: SyncLogDatabase

  const stored = () => db.getAll<ItemSyncRecord>(SYNC_LOG_STORES.items)

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
  })

  afterEach(async () => {
    await db.close()
  })

  it('has no heads for an item it has never seen', () => {
    const heads = new ServerHeads(db)

    expect(heads.get(ITEM_1)).toEqual([])
    expect(heads.has(ITEM_1)).toBe(false)
  })

  it('loads the stored heads', async () => {
    await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['a'] }, { itemId: ITEM_2, baseVersion: 2 })
    const heads = new ServerHeads(db)

    await heads.load()

    expect(heads.get(ITEM_1)).toEqual(['a'])
    expect(heads.has(ITEM_2)).toBe(false)
  })

  it('writes only the items this tab changed, so another tab\'s heads survive', async () => {
    const heads = new ServerHeads(db)
    await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['from another tab'] })

    heads.set(ITEM_2, ['mine'])
    await heads.save()

    expect(await stored()).toEqual([
      { itemId: ITEM_1, serverHeads: ['from another tab'] },
      { itemId: ITEM_2, serverHeads: ['mine'] },
    ])
  })

  it('keeps the rest of the item\'s record', async () => {
    await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, baseVersion: 4, dirty: true })
    const heads = new ServerHeads(db)

    heads.set(ITEM_1, ['a'])
    await heads.save()

    expect(await stored()).toEqual([{ itemId: ITEM_1, baseVersion: 4, dirty: true, serverHeads: ['a'] }])
  })

  it('writes nothing when no heads changed', async () => {
    await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['a'] })
    const update = vi.spyOn(db, 'update')
    const heads = new ServerHeads(db)
    await heads.load()

    heads.set(ITEM_1, ['a'])
    await heads.save()

    expect(update).not.toHaveBeenCalled()
  })

  it('keeps heads it has not saved across a reload', async () => {
    await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, serverHeads: ['stored'] })
    const heads = new ServerHeads(db)
    heads.set(ITEM_1, ['newer'])

    await heads.load()

    expect(heads.get(ITEM_1)).toEqual(['newer'])
    await heads.shutdown({ clearLocalData: true })
  })

  it('saves them again after a failed save', async () => {
    vi.spyOn(db, 'update').mockRejectedValueOnce(new Error('quota'))
    const heads = new ServerHeads(db)
    heads.set(ITEM_1, ['a'])

    await heads.save()
    await heads.save()

    expect(await stored()).toEqual([{ itemId: ITEM_1, serverHeads: ['a'] }])
  })

  it('saves on shutdown, unless local data is being cleared', async () => {
    const clearing = new ServerHeads(db)
    clearing.set(ITEM_1, ['a'])
    await clearing.shutdown({ clearLocalData: true })
    expect(await stored()).toEqual([])

    const stopping = new ServerHeads(db)
    stopping.set(ITEM_1, ['a'])
    await stopping.shutdown()
    expect(await stored()).toEqual([{ itemId: ITEM_1, serverHeads: ['a'] }])
  })
})
