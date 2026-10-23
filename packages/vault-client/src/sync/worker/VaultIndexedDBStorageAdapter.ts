import { StorageAdapterInterface, StorageKey, Chunk } from '@automerge/automerge-repo/slim'
import { createLogger } from '../utils/logger'

const log = createLogger('VaultIndexedDBStorageAdapter')

/**
 * Turns a chunk's bytes into the record stored in IndexedDB and back. Both run outside any
 * IndexedDB transaction, so they may await anything.
 */
export interface RecordCodec {
  encode(key: StorageKey, bytes: Uint8Array): Promise<unknown>
  /** Throws when the record can't be opened. Never return undefined for a record that failed. */
  decode(key: StorageKey, record: unknown): Promise<Uint8Array | undefined>
}

/** The `{ key, binary }` records the adapter has always stored */
export const plaintextRecordCodec: RecordCodec = {
  encode: async (key, bytes) => ({ key, binary: bytes }),
  decode: async (_key, record) => {
    if (record && typeof record === 'object' && 'binary' in record) {
      return (record as { binary: Uint8Array }).binary
    }
    return undefined
  },
}

export interface VaultIndexedDBStorageAdapterOptions {
  /** The object store holding chunks. Defaults to 'documents'. */
  storeName?: string
  /**
   * Opens the database at this version and creates `storeName` and `extraStores` on upgrade.
   * Without it the database opens at its current version, as older builds did.
   */
  version?: number
  extraStores?: string[]
  codec?: RecordCodec
  /** Called for each record the codec fails to decode, before the load rejects */
  onOpenFailure?: (key: StorageKey, error: unknown) => void
}

const META_STORE = 'meta'

export class VaultIndexedDBStorageAdapter implements StorageAdapterInterface {
  private db: IDBDatabase | null = null
  private dbPromise: Promise<IDBDatabase> | null = null
  private isExplicitlyClosed = false
  private isClosing = false
  private activeTransactions = 0
  private drainResolve: (() => void) | null = null
  private closePromise: Promise<void> | null = null
  private readonly storeName: string
  private readonly version: number | undefined
  private readonly extraStores: string[]
  private readonly codec: RecordCodec
  private readonly onOpenFailure: ((key: StorageKey, error: unknown) => void) | undefined

  constructor(
    private readonly databaseName: string,
    options: VaultIndexedDBStorageAdapterOptions = {}
  ) {
    this.storeName = options.storeName ?? 'documents'
    this.version = options.version
    this.extraStores = options.extraStores ?? []
    this.codec = options.codec ?? plaintextRecordCodec
    this.onOpenFailure = options.onOpenFailure
    this.dbPromise = this.connect()
  }

  private connect(): Promise<IDBDatabase> {
    const promise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.version === undefined
        ? indexedDB.open(this.databaseName)
        : indexedDB.open(this.databaseName, this.version)

      request.onerror = () => reject(request.error)
      request.onsuccess = event => {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        this.db = db
        db.addEventListener('versionchange', () => {
          this.handleVersionChange(db)
        })
        db.addEventListener('close', () => {
          this.handleUnexpectedClose(db)
        })
        resolve(db)
      }
      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        const storeNames = this.version === undefined ? [this.storeName] : [this.storeName, ...this.extraStores]
        for (const name of storeNames) {
          if (!db.objectStoreNames || !db.objectStoreNames.contains(name)) {
            db.createObjectStore(name)
          }
        }
      }
    })

    promise.catch(() => {
      if (this.dbPromise === promise) {
        this.dbPromise = null
      }
    })

    return promise
  }

  private handleVersionChange(db: IDBDatabase): void {
    log.warn(
      `Database versionchange event received for ${this.databaseName}. Closing connection to yield to upgrade/deletion.`
    )

    if (this.db === db) {
      this.db = null
      this.dbPromise = null
    }

    try {
      db.close()
    } catch (err) {
      log.warn(`Error closing db on versionchange:`, err)
    }
  }

  private handleUnexpectedClose(db: IDBDatabase): void {
    if (this.isExplicitlyClosed || this.isClosing) {
      return
    }

    log.warn(
      `Database connection unexpectedly closed for ${this.databaseName}.`
    )

    if (this.db === db) {
      this.db = null
      this.dbPromise = null
    }
  }

  private async getDB(): Promise<IDBDatabase> {
    if (this.isExplicitlyClosed || this.isClosing) throw new Error('Database is closed')
    if (this.db) return this.db
    if (this.dbPromise) return this.dbPromise

    this.dbPromise = this.connect()
    return this.dbPromise
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }

    this.closePromise = (async () => {
      this.isClosing = true
      this.isExplicitlyClosed = true

      // If connection is in progress, wait for it to settle
      if (this.dbPromise) {
        try {
          await this.dbPromise
        } catch {
          // Open failed, nothing open to close
        }
      }

      // Wait for any active in-flight transactions to drain
      if (this.activeTransactions > 0) {
        await new Promise<void>(resolve => {
          this.drainResolve = resolve
        })
      }

      const db = this.db
      this.db = null
      this.dbPromise = null

      if (db) {
        await new Promise<void>(resolve => {
          let settled = false
          const done = () => {
            if (settled) return
            settled = true
            db.removeEventListener('close', done)
            resolve()
          }
          db.addEventListener('close', done, { once: true })
          try {
            db.close()
          } catch {
            done()
            return
          }
          // Fallback timer in case the runtime/browser doesn't fire 'close' on explicit close()
          setTimeout(done, 25)
        })
      }
    })()

    return this.closePromise
  }

  private async withTransaction<T = void>(
    storeName: string,
    mode: IDBTransactionMode,
    callback: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T> | T | void
  ): Promise<T> {
    if (this.isExplicitlyClosed || this.isClosing) {
      throw new Error('Database is closed')
    }

    const MAX_RETRIES = 2
    let attempt = 0

    this.activeTransactions += 1
    try {
      while (true) {
        if (this.isExplicitlyClosed || this.isClosing) {
          throw new Error('Database is closed')
        }

        const db = await this.getDB()
        let transaction: IDBTransaction
        let store: IDBObjectStore

        try {
          transaction = db.transaction(storeName, mode)
          store = transaction.objectStore(storeName)
        } catch (err) {
          const isInvalidState =
            (err instanceof DOMException && err.name === 'InvalidStateError') ||
            (err instanceof Error && (err.name === 'InvalidStateError' || /closed|closing/i.test(err.message)))

          if (isInvalidState && !this.isExplicitlyClosed && !this.isClosing && attempt < MAX_RETRIES) {
            log.warn(
              `Transaction creation failed on closing/closed connection for ${this.databaseName}. Reconnecting... (attempt ${attempt + 1})`,
              err
            )
            if (this.db === db) {
              this.db = null
              this.dbPromise = null
            }
            attempt += 1
            continue
          }
          throw err
        }

        return await new Promise<T>((resolve, reject) => {
          let isSettled = false
          let result: T | undefined

          const safeResolve = (val: T) => {
            if (!isSettled) {
              isSettled = true
              resolve(val)
            }
          }

          const safeReject = (err: unknown) => {
            if (!isSettled) {
              isSettled = true
              reject(err)
            }
          }

          // A failed request's error bubbles here before the transaction's own error is set
          transaction.onerror = event =>
            safeReject(transaction.error ?? (event?.target as IDBRequest | null)?.error ?? null)
          transaction.onabort = () =>
            safeReject(transaction.error || new DOMException('Transaction aborted', 'AbortError'))
          transaction.oncomplete = () => {
            safeResolve(result as T)
          }

          try {
            const cbResult = callback(store, transaction)
            if (cbResult instanceof Promise) {
              cbResult.then(
                res => {
                  result = res
                  if (mode === 'readonly') {
                    safeResolve(res)
                  }
                },
                err => safeReject(err)
              )
            } else if (cbResult !== undefined) {
              result = cbResult
              if (mode === 'readonly') {
                safeResolve(cbResult)
              }
            }
          } catch (err) {
            safeReject(err)
          }
        })
      }
    } finally {
      this.activeTransactions -= 1
      if (this.activeTransactions === 0 && this.drainResolve) {
        this.drainResolve()
        this.drainResolve = null
      }
    }
  }

  private async decode(key: StorageKey, record: unknown): Promise<Uint8Array | undefined> {
    try {
      return await this.codec.decode(key, record)
    } catch (error) {
      this.onOpenFailure?.(key, error)
      throw error
    }
  }

  private async decodeChunks(records: { key: StorageKey, record: unknown }[]): Promise<Chunk[]> {
    return Promise.all(records.map(async ({ key, record }) => ({ key, data: await this.decode(key, record) })))
  }

  private readRecords(range: IDBKeyRange | undefined, limit = Infinity): Promise<{ key: StorageKey, record: unknown }[]> {
    return this.withTransaction(this.storeName, 'readonly', store => {
      return new Promise((resolve, reject) => {
        const request = store.openCursor(range)
        const records: { key: StorageKey, record: unknown }[] = []

        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor && records.length < limit) {
            records.push({ key: cursor.key as StorageKey, record: cursor.value })
            cursor.continue()
          } else {
            resolve(records)
          }
        }
      })
    })
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    const record = await this.withTransaction<unknown>(this.storeName, 'readonly', store => {
      return new Promise((resolve, reject) => {
        const request = store.get(key)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      })
    })
    if (record === undefined) {
      return undefined
    }
    return this.decode(key, record)
  }

  async save(key: string[], binary: Uint8Array): Promise<void> {
    const record = await this.codec.encode(key, binary)
    return this.withTransaction(this.storeName, 'readwrite', store => {
      store.put(record, key)
    })
  }

  async remove(key: string[]): Promise<void> {
    return this.withTransaction(this.storeName, 'readwrite', store => {
      store.delete(key)
    })
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, '\uffff']
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    return this.decodeChunks(await this.readRecords(range))
  }

  /** Up to `limit` chunks in key order, starting after `afterKey` (exclusive), or from the start */
  async loadPage(afterKey: string[] | undefined, limit: number): Promise<Chunk[]> {
    if (limit <= 0) {
      return []
    }
    const range = afterKey ? IDBKeyRange.lowerBound(afterKey, true) : undefined
    return this.decodeChunks(await this.readRecords(range, limit))
  }

  /** Reads a value from the `meta` store, which the database must have been opened with */
  async getMeta<T = unknown>(key: IDBValidKey): Promise<T | undefined> {
    return this.withTransaction<T | undefined>(META_STORE, 'readonly', store => {
      return new Promise((resolve, reject) => {
        const request = store.get(key)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result as T | undefined)
      })
    })
  }

  /** Adds a value to the `meta` store. Rejects with a `ConstraintError` if the key exists. */
  async addMeta(key: IDBValidKey, value: unknown): Promise<void> {
    return this.withTransaction(META_STORE, 'readwrite', store => {
      return new Promise<void>((resolve, reject) => {
        const request = store.add(value, key)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve()
      })
    })
  }

  async putMeta(key: IDBValidKey, value: unknown): Promise<void> {
    return this.withTransaction(META_STORE, 'readwrite', store => {
      store.put(value, key)
    })
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, '\uffff']
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    return this.withTransaction(this.storeName, 'readwrite', store => {
      store.delete(range)
    })
  }

  async has(keyPrefix: string[]): Promise<boolean> {
    const range = keyPrefix.length > 0
      ? IDBKeyRange.bound(keyPrefix, [...keyPrefix, '\uffff'])
      : undefined

    return this.withTransaction(this.storeName, 'readonly', store => {
      return new Promise((resolve, reject) => {
        const request = typeof store.openKeyCursor === 'function'
          ? store.openKeyCursor(range)
          : store.openCursor(range)

        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          resolve(request.result != null)
        }
      })
    })
  }
}

