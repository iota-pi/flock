import { getSyncLogDatabaseName, SYNC_LOG_STORES, type SyncLogStoreName } from '../../shared/syncLogStorage'
import { runStorageOperation } from '../../utils/storageManager'
import { createLogger } from '../../utils/logger'

const log = createLogger('SyncLogDatabase')

const DB_VERSION = 1

const KEY_PATHS: Record<SyncLogStoreName, string> = {
  [SYNC_LOG_STORES.outbox]: 'itemId',
  [SYNC_LOG_STORES.parked]: 'seq',
  [SYNC_LOG_STORES.firstStart]: 'itemId',
  [SYNC_LOG_STORES.snapshotRechecks]: 'itemId',
  [SYNC_LOG_STORES.unconfirmedPulls]: 'itemId',
}

/**
 * The account's sync log database, opened on first use. It talks to IndexedDB directly rather than
 * through localforage, because clearing a pending mark must compare and delete in one transaction:
 * other tabs write marks too.
 */
export class SyncLogDatabase {
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(private readonly accountId: string) {}

  /** Counts the items with pending marks, for a session that can't open the rest of local storage */
  static async countPending(accountId: string): Promise<number> {
    const database = new SyncLogDatabase(accountId)
    try {
      return await database.count(SYNC_LOG_STORES.outbox)
    } finally {
      await database.close()
    }
  }

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(getSyncLogDatabaseName(this.accountId), DB_VERSION)
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of Object.entries(KEY_PATHS)) {
          request.result.createObjectStore(name, { keyPath })
        }
      }
      request.onerror = () => {
        this.dbPromise = null
        reject(request.error)
      }
      request.onsuccess = () => {
        const db = request.result
        // Local data cleanup deletes the database, which an open connection would block
        db.onversionchange = () => {
          db.close()
          this.dbPromise = null
        }
        resolve(db)
      }
    })
    return this.dbPromise
  }

  /** Runs `task` in one transaction and resolves with its request's result once the transaction commits */
  private async transact<T>(
    store: SyncLogStoreName,
    mode: IDBTransactionMode,
    task: (objectStore: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T | undefined> {
    return runStorageOperation(async () => {
      const db = await this.open()
      return new Promise<T | undefined>((resolve, reject) => {
        const transaction = db.transaction(store, mode)
        let result: T | undefined
        const request = task(transaction.objectStore(store))
        if (request) {
          request.addEventListener('success', () => {
            result = request.result
          })
        }
        transaction.oncomplete = () => resolve(result)
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    })
  }

  async get<T>(store: SyncLogStoreName, key: IDBValidKey): Promise<T | undefined> {
    return this.transact<T>(store, 'readonly', objectStore => objectStore.get(key))
  }

  async getAll<T>(store: SyncLogStoreName): Promise<T[]> {
    return await this.transact<T[]>(store, 'readonly', objectStore => objectStore.getAll()) ?? []
  }

  async count(store: SyncLogStoreName): Promise<number> {
    return await this.transact<number>(store, 'readonly', objectStore => objectStore.count()) ?? 0
  }

  async put(store: SyncLogStoreName, ...records: object[]): Promise<void> {
    if (records.length === 0) return
    await this.transact(store, 'readwrite', objectStore => {
      for (const record of records) {
        objectStore.put(record)
      }
    })
  }

  /** Writes `record` unless `key` already has one */
  async putIfAbsent(store: SyncLogStoreName, key: IDBValidKey, record: object): Promise<void> {
    await this.transact(store, 'readwrite', objectStore => {
      const existing = objectStore.getKey(key)
      existing.onsuccess = () => {
        if (existing.result === undefined) objectStore.put(record)
      }
    })
  }

  async delete(store: SyncLogStoreName, ...keys: IDBValidKey[]): Promise<void> {
    if (keys.length === 0) return
    await this.transact(store, 'readwrite', objectStore => {
      for (const key of keys) {
        objectStore.delete(key)
      }
    })
  }

  /** Deletes the record at `key` if `matches` accepts it, in one transaction */
  async deleteIf<T>(store: SyncLogStoreName, key: IDBValidKey, matches: (record: T) => boolean): Promise<void> {
    await this.transact(store, 'readwrite', objectStore => {
      const current = objectStore.get(key) as IDBRequest<T | undefined>
      current.onsuccess = () => {
        if (current.result !== undefined && matches(current.result)) {
          objectStore.delete(key)
        }
      }
    })
  }

  async close(): Promise<void> {
    const opening = this.dbPromise
    this.dbPromise = null
    if (!opening) return
    try {
      (await opening).close()
    } catch (error) {
      log.warn('Failed to close the sync log database', error)
    }
  }
}
