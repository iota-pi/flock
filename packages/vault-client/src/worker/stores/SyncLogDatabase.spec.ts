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

  it('upgrades a database an older build created, keeping its records', async () => {
    const name = getSyncLogDatabaseName('account-1')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => {
        for (const store of ['outbox', 'parked', 'first-start', 'snapshot-rechecks', 'unconfirmed-pulls']) {
          request.result.createObjectStore(store, { keyPath: store === 'parked' ? 'seq' : 'itemId' })
        }
      }
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction('outbox', 'readwrite')
        transaction.objectStore('outbox').put({ itemId: 'item-1', tick: 1 })
        transaction.oncomplete = () => {
          db.close()
          resolve()
        }
      }
      request.onerror = () => reject(request.error)
    })

    await database.put(SYNC_LOG_STORES.items, { itemId: 'item-1', baseVersion: 2 })

    expect(await database.getAll(SYNC_LOG_STORES.outbox)).toEqual([{ itemId: 'item-1', tick: 1 }])
    expect(await database.getAll(SYNC_LOG_STORES.items)).toEqual([{ itemId: 'item-1', baseVersion: 2 }])
    await database.close()
    const storeNames = await new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open(name)
      request.onsuccess = () => {
        const names = Array.from(request.result.objectStoreNames)
        request.result.close()
        resolve(names)
      }
      request.onerror = () => reject(request.error)
    })
    expect(storeNames).not.toContain('snapshot-rechecks')
    expect(storeNames).toEqual(expect.arrayContaining(Object.values(SYNC_LOG_STORES)))
  })

  it('creates only the stores in use for a new database', async () => {
    await database.put(SYNC_LOG_STORES.outbox, { itemId: 'item-1', tick: 1 })
    await database.close()
    const storeNames = await new Promise<string[]>((resolve, reject) => {
      const request = indexedDB.open(getSyncLogDatabaseName('account-1'))
      request.onsuccess = () => {
        const names = Array.from(request.result.objectStoreNames)
        request.result.close()
        resolve(names)
      }
      request.onerror = () => reject(request.error)
    })
    expect(storeNames.sort()).toEqual([SYNC_LOG_STORES.items, SYNC_LOG_STORES.outbox, SYNC_LOG_STORES.parked].sort())
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
