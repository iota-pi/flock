import { IDBFactory } from 'fake-indexeddb'
import { clearSyncLogStorage, getSyncLogDatabaseName, SYNC_LOG_STORES } from '../../shared/syncLogStorage'
import { SyncLogDatabase } from './SyncLogDatabase'

describe('SyncLogDatabase', () => {
  let database: SyncLogDatabase

  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    database = new SyncLogDatabase('account-1')
  })

  afterEach(async () => {
    await database.close()
  })

  it('stores records by item, and parked entries by seq', async () => {
    await database.put(SYNC_LOG_STORES.outbox, { itemId: 'item-1', tick: 1 })
    await database.put(SYNC_LOG_STORES.parked, { seq: 7, itemId: 'item-1' })

    expect(await database.get(SYNC_LOG_STORES.outbox, 'item-1')).toEqual({ itemId: 'item-1', tick: 1 })
    expect(await database.getAll(SYNC_LOG_STORES.parked)).toEqual([{ seq: 7, itemId: 'item-1' }])
    expect(await database.count(SYNC_LOG_STORES.outbox)).toBe(1)
  })

  it('deletes a record only if it still matches', async () => {
    await database.put(SYNC_LOG_STORES.outbox, { itemId: 'item-1', tick: 2 })

    await database.deleteIf<{ tick: number }>(SYNC_LOG_STORES.outbox, 'item-1', record => record.tick === 1)
    expect(await database.count(SYNC_LOG_STORES.outbox)).toBe(1)

    await database.deleteIf<{ tick: number }>(SYNC_LOG_STORES.outbox, 'item-1', record => record.tick === 2)
    expect(await database.count(SYNC_LOG_STORES.outbox)).toBe(0)
  })

  it('keeps an existing record over one written if absent', async () => {
    await database.putIfAbsent(SYNC_LOG_STORES.unconfirmedPulls, 'item-1', { itemId: 'item-1', firstSeenAt: 1 })
    await database.putIfAbsent(SYNC_LOG_STORES.unconfirmedPulls, 'item-1', { itemId: 'item-1', firstSeenAt: 2 })

    expect(await database.get(SYNC_LOG_STORES.unconfirmedPulls, 'item-1')).toEqual({ itemId: 'item-1', firstSeenAt: 1 })
  })

  it('counts pending items without staying open', async () => {
    await database.put(SYNC_LOG_STORES.outbox, { itemId: 'item-1', tick: 1 }, { itemId: 'item-2', tick: 2 })

    expect(await SyncLogDatabase.countPending('account-1')).toBe(2)
  })

  it('lets local data cleanup delete it while a connection is open', async () => {
    await database.put(SYNC_LOG_STORES.outbox, { itemId: 'item-1', tick: 1 })

    await clearSyncLogStorage('account-1')

    const names = (await indexedDB.databases()).map(db => db.name)
    expect(names).not.toContain(getSyncLogDatabaseName('account-1'))
  })
})
