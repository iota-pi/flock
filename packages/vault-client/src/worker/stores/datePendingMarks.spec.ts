import { IDBFactory } from 'fake-indexeddb'
import type { ItemId } from '@vault/shared'
import { SYNC_LOG_STORES } from '../../shared/syncLogStorage'
import { SyncLogDatabase } from './SyncLogDatabase'
import { datePendingMarks } from './datePendingMarks'

const ACCOUNT = 'account-1'
const ITEM_1 = 'item-1' as ItemId
const ITEM_2 = 'item-2' as ItemId

describe('datePendingMarks', () => {
  let db: SyncLogDatabase

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    db = new SyncLogDatabase(ACCOUNT)
  })

  afterEach(async () => {
    await db.close()
  })

  it('dates marks written before marks had an age, and keeps the dates of the rest', async () => {
    await db.put(
      SYNC_LOG_STORES.outbox,
      { itemId: ITEM_1, tick: 1, blocked: 'unloadable' },
      { itemId: ITEM_2, tick: 2, createdAt: 1_000 },
    )

    await datePendingMarks(ACCOUNT, 7_000)

    expect(await db.getAll(SYNC_LOG_STORES.outbox)).toEqual([
      { itemId: ITEM_1, tick: 1, blocked: 'unloadable', createdAt: 7_000 },
      { itemId: ITEM_2, tick: 2, createdAt: 1_000 },
    ])
  })

  it('does nothing with no marks', async () => {
    await datePendingMarks(ACCOUNT, 7_000)

    expect(await db.getAll(SYNC_LOG_STORES.outbox)).toEqual([])
  })
})
