import { IDBFactory } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { SYNC_LOG_STORES } from '../../shared/syncLogStorage'
import { SyncLogDatabase } from './SyncLogDatabase'
import {
  clearServerHeads,
  importItemSyncRecords,
  readItemSyncRecords,
  updateItemSyncRecords,
  type ItemSyncRecord,
} from './itemSyncRecords'

const ITEM_1 = 'item-1' as ItemId
const ITEM_2 = 'item-2' as ItemId

describe('item sync records', () => {
  let db: SyncLogDatabase

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase('account-1')
  })

  afterEach(async () => {
    await db.close()
  })

  it('updates each item from its current record, or an empty one', async () => {
    await db.put(SYNC_LOG_STORES.items, { itemId: ITEM_1, baseVersion: 2 })

    await updateItemSyncRecords(db, [ITEM_1, ITEM_2], record => ({ ...record, dirty: true }))

    expect(await readItemSyncRecords(db)).toEqual([
      { itemId: ITEM_1, baseVersion: 2, dirty: true },
      { itemId: ITEM_2, dirty: true },
    ])
  })

  it('clears server heads, keeping the rest of each record', async () => {
    await db.put(
      SYNC_LOG_STORES.items,
      { itemId: ITEM_1, serverHeads: ['a'], baseVersion: 3 },
      { itemId: ITEM_2, dirty: true },
    )

    await clearServerHeads(db)

    expect(await readItemSyncRecords(db)).toEqual([
      { itemId: ITEM_1, baseVersion: 3 },
      { itemId: ITEM_2, dirty: true },
    ])
  })

  describe('importItemSyncRecords', () => {
    const stored = () => readItemSyncRecords(db)

    it('adds records for items that have none', async () => {
      await importItemSyncRecords('account-1', [
        { itemId: ITEM_1, serverHeads: ['h'], baseVersion: 2, dirty: true },
      ])

      expect(await stored()).toEqual([{ itemId: ITEM_1, serverHeads: ['h'], baseVersion: 2, dirty: true }])
    })

    it('keeps what an existing record has: its heads, the higher version, and either dirty flag', async () => {
      const existing: ItemSyncRecord[] = [
        { itemId: ITEM_1, serverHeads: ['newer'], baseVersion: 5 },
        { itemId: ITEM_2, baseVersion: 1, dirty: true },
      ]
      await db.put(SYNC_LOG_STORES.items, ...existing)

      await importItemSyncRecords('account-1', [
        { itemId: ITEM_1, serverHeads: ['older'], baseVersion: 3, dirty: true },
        { itemId: ITEM_2, serverHeads: ['h2'], baseVersion: 4 },
      ])

      expect(await stored()).toEqual([
        { itemId: ITEM_1, serverHeads: ['newer'], baseVersion: 5, dirty: true },
        { itemId: ITEM_2, serverHeads: ['h2'], baseVersion: 4, dirty: true },
      ])
    })

    it('does nothing without records', async () => {
      await importItemSyncRecords('account-1', [])

      expect(await stored()).toEqual([])
    })
  })
})
