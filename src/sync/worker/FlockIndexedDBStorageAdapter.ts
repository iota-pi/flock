import { StorageAdapterInterface, StorageKey, Chunk } from '@automerge/automerge-repo/slim'

export class FlockIndexedDBStorageAdapter implements StorageAdapterInterface {
  private db: IDBDatabase | null = null
  private dbPromise: Promise<IDBDatabase> | null = null
  private isExplicitlyClosed = false
  private isClosing = false
  private activeTransactions = 0
  private drainResolve: (() => void) | null = null
  private closePromise: Promise<void> | null = null

  constructor(
    private readonly databaseName: string,
    private readonly storeName: string = 'documents'
  ) {
    this.dbPromise = this.connect()
  }

  private connect(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName)

      request.onerror = () => reject(request.error)
      request.onsuccess = event => {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        this.db = db
        db.addEventListener('versionchange', () => {
          console.warn(`[FlockIndexedDBStorageAdapter] Database versionchange event received for ${this.databaseName}. Closing connection.`)
          void this.close()
        })
        resolve(db)
      }
      request.onupgradeneeded = event => {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        db.createObjectStore(this.storeName)
      }
    })
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

    this.activeTransactions += 1
    try {
      const db = await this.getDB()
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

        const transaction = db.transaction(storeName, mode)
        const store = transaction.objectStore(storeName)

        transaction.onerror = () => safeReject(transaction.error)
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
    } finally {
      this.activeTransactions -= 1
      if (this.activeTransactions === 0 && this.drainResolve) {
        this.drainResolve()
        this.drainResolve = null
      }
    }
  }

  async clear(): Promise<void> {
    return this.withTransaction(this.storeName, 'readwrite', store => {
      store.clear()
    })
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return this.withTransaction(this.storeName, 'readonly', store => {
      return new Promise((resolve, reject) => {
        const request = store.get(key)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const result = request.result
          if (result && typeof result === 'object' && 'binary' in result) {
            resolve((result as { binary: Uint8Array }).binary)
          } else {
            resolve(undefined)
          }
        }
      })
    })
  }

  async save(key: string[], binary: Uint8Array): Promise<void> {
    return this.withTransaction(this.storeName, 'readwrite', store => {
      store.put({ key, binary }, key)
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

    return this.withTransaction(this.storeName, 'readonly', store => {
      return new Promise((resolve, reject) => {
        const request = store.openCursor(range)
        const chunks: Chunk[] = []

        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const cursor = request.result
          if (cursor) {
            chunks.push({
              data: (cursor.value as { binary: Uint8Array }).binary,
              key: cursor.key as StorageKey,
            })
            cursor.continue()
          } else {
            resolve(chunks)
          }
        }
      })
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
}
