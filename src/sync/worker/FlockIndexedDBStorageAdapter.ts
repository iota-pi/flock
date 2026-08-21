import { StorageAdapterInterface, StorageKey, Chunk } from '@automerge/automerge-repo/slim'

export class FlockIndexedDBStorageAdapter implements StorageAdapterInterface {
  private db: IDBDatabase | null = null
  private dbPromise: Promise<IDBDatabase> | null = null
  private isExplicitlyClosed = false

  constructor(
    private readonly databaseName: string,
    private readonly storeName: string = 'documents'
  ) {
    this.dbPromise = this.connect()
  }

  private connect(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1)

      request.onerror = () => reject(request.error)
      request.onsuccess = event => {
        const db = (event.target as IDBOpenDBRequest).result as IDBDatabase
        this.db = db
        db.addEventListener('versionchange', () => {
          console.warn(`[FlockIndexedDBStorageAdapter] Database versionchange event received for ${this.databaseName}. Closing connection.`)
          this.disconnect()
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
    if (this.db) return this.db
    if (this.dbPromise) return this.dbPromise
    if (this.isExplicitlyClosed) throw new Error('Database is closed')

    this.dbPromise = this.connect()
    return this.dbPromise
  }

  close(): void {
    this.isExplicitlyClosed = true
    this.disconnect()
  }

  private disconnect(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    this.dbPromise = null
  }

  async clear(): Promise<void> {
    const db = await this.getDB()
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite')
      const store = transaction.objectStore(this.storeName)
      const request = store.clear()

      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted', 'AbortError'))
      request.onsuccess = () => resolve()
    })
  }


  async load(key: string[]): Promise<Uint8Array | undefined> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly')
      const store = transaction.objectStore(this.storeName)
      const request = store.get(key)

      transaction.onerror = () => reject(request.error || transaction.error)
      transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted', 'AbortError'))
      request.onsuccess = () => {
        const result = request.result
        if (result && typeof result === 'object' && 'binary' in result) {
          resolve((result as { binary: Uint8Array }).binary)
        } else {
          resolve(undefined)
        }
      }
    })
  }

  async save(key: string[], binary: Uint8Array): Promise<void> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite')
      const store = transaction.objectStore(this.storeName)
      store.put({ key, binary }, key)

      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted', 'AbortError'))
      transaction.oncomplete = () => resolve()
    })
  }

  async remove(key: string[]): Promise<void> {
    const db = await this.getDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite')
      const store = transaction.objectStore(this.storeName)
      store.delete(key)

      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted', 'AbortError'))
      transaction.oncomplete = () => resolve()
    })
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    const db = await this.getDB()
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, '\uffff']
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly')
      const store = transaction.objectStore(this.storeName)
      const request = store.openCursor(range)
      const chunks: Chunk[] = []

      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted', 'AbortError'))
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
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const db = await this.getDB()
    const lowerBound = keyPrefix
    const upperBound = [...keyPrefix, '\uffff']
    const range = IDBKeyRange.bound(lowerBound, upperBound)

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite')
      const store = transaction.objectStore(this.storeName)
      store.delete(range)

      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error || new DOMException('Transaction aborted', 'AbortError'))
      transaction.oncomplete = () => resolve()
    })
  }
}
