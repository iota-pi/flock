import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FlockIndexedDBStorageAdapter } from './FlockIndexedDBStorageAdapter'

describe('FlockIndexedDBStorageAdapter', () => {
  const originalIndexedDB = globalThis.indexedDB
  let mockOpenRequest: any
  let mockDb: any
  let mockTransaction: any
  let mockStore: any

  beforeEach(() => {
    mockStore = {
      clear: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      openCursor: vi.fn(),
    }

    mockTransaction = {
      objectStore: vi.fn().mockReturnValue(mockStore),
      onerror: null,
      onabort: null,
      oncomplete: null,
      error: null,
    }

    mockDb = {
      transaction: vi.fn().mockReturnValue(mockTransaction),
      createObjectStore: vi.fn(),
      addEventListener: vi.fn(),
      close: vi.fn(),
    }

    mockOpenRequest = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: mockDb,
      error: null,
    }

    globalThis.indexedDB = {
      open: vi.fn().mockImplementation(() => {
        queueMicrotask(() => {
          if (mockOpenRequest.onsuccess) {
            mockOpenRequest.onsuccess({ target: mockOpenRequest })
          }
        })
        return mockOpenRequest
      }),
    } as any
  })

  afterEach(() => {
    globalThis.indexedDB = originalIndexedDB
  })

  describe('clear()', () => {
    it('waits for transaction.oncomplete before resolving and does NOT resolve prematurely', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')

      let resolved = false
      const clearPromise = adapter.clear().then(() => {
        resolved = true
      })

      // Wait for connect() to finish and clear() to initiate transaction
      await new Promise(r => setTimeout(r, 10))

      expect(mockDb.transaction).toHaveBeenCalledWith('documents', 'readwrite')
      expect(mockStore.clear).toHaveBeenCalled()

      // The clear promise MUST still be pending because oncomplete has not fired
      expect(resolved).toBe(false)

      // Complete the transaction
      mockTransaction.oncomplete()
      await clearPromise

      expect(resolved).toBe(true)
    })

    it('rejects when transaction.onerror fires', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')

      const clearPromise = adapter.clear()
      await new Promise(r => setTimeout(r, 10))

      const testError = new Error('Transaction failed')
      mockTransaction.error = testError
      mockTransaction.onerror()

      await expect(clearPromise).rejects.toThrow('Transaction failed')
    })

    it('rejects when transaction.onabort fires', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')

      const clearPromise = adapter.clear()
      await new Promise(r => setTimeout(r, 10))

      mockTransaction.error = null
      mockTransaction.onabort()

      await expect(clearPromise).rejects.toThrow('Transaction aborted')
    })
  })

  describe('save() and remove()', () => {
    it('save() waits for transaction.oncomplete', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      let resolved = false
      const savePromise = adapter.save(['doc-1'], new Uint8Array([1, 2, 3])).then(() => {
        resolved = true
      })

      await new Promise(r => setTimeout(r, 10))
      expect(mockStore.put).toHaveBeenCalledWith(
        { key: ['doc-1'], binary: new Uint8Array([1, 2, 3]) },
        ['doc-1']
      )
      expect(resolved).toBe(false)

      mockTransaction.oncomplete()
      await savePromise
      expect(resolved).toBe(true)
    })

    it('remove() waits for transaction.oncomplete', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      let resolved = false
      const removePromise = adapter.remove(['doc-1']).then(() => {
        resolved = true
      })

      await new Promise(r => setTimeout(r, 10))
      expect(mockStore.delete).toHaveBeenCalledWith(['doc-1'])
      expect(resolved).toBe(false)

      mockTransaction.oncomplete()
      await removePromise
      expect(resolved).toBe(true)
    })
  })

  describe('removeRange()', () => {
    beforeEach(() => {
      if (typeof globalThis.IDBKeyRange === 'undefined') {
        globalThis.IDBKeyRange = {
          bound: vi.fn((lower, upper) => ({ lower, upper })),
        } as any
      }
    })

    it('waits for transaction.oncomplete', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      let resolved = false
      const removeRangePromise = adapter.removeRange(['doc-prefix']).then(() => {
        resolved = true
      })

      await new Promise(r => setTimeout(r, 10))
      expect(mockStore.delete).toHaveBeenCalled()
      expect(resolved).toBe(false)

      mockTransaction.oncomplete()
      await removeRangePromise
      expect(resolved).toBe(true)
    })
  })

  describe('load()', () => {
    it('loads binary data successfully', async () => {
      const mockRequest: any = { onsuccess: null, onerror: null, result: { binary: new Uint8Array([1, 2, 3]) } }
      mockStore.get.mockReturnValue(mockRequest)

      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      const loadPromise = adapter.load(['doc-1'])
      await new Promise(r => setTimeout(r, 10))

      mockRequest.onsuccess()
      const result = await loadPromise
      expect(result).toEqual(new Uint8Array([1, 2, 3]))
      expect(mockStore.get).toHaveBeenCalledWith(['doc-1'])
    })

    it('returns undefined if result has no binary', async () => {
      const mockRequest: any = { onsuccess: null, onerror: null, result: undefined }
      mockStore.get.mockReturnValue(mockRequest)

      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      const loadPromise = adapter.load(['doc-1'])
      await new Promise(r => setTimeout(r, 10))

      mockRequest.onsuccess()
      const result = await loadPromise
      expect(result).toBeUndefined()
    })

    it('rejects when request.onerror fires', async () => {
      const mockRequest: any = { onsuccess: null, onerror: null, error: new Error('Get failed') }
      mockStore.get.mockReturnValue(mockRequest)

      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      const loadPromise = adapter.load(['doc-1'])
      await new Promise(r => setTimeout(r, 10))

      mockRequest.onerror()
      await expect(loadPromise).rejects.toThrow('Get failed')
    })
  })

  describe('loadRange()', () => {
    beforeEach(() => {
      if (typeof globalThis.IDBKeyRange === 'undefined') {
        globalThis.IDBKeyRange = {
          bound: vi.fn((lower, upper) => ({ lower, upper })),
        } as any
      }
    })

    it('loads range of chunks using cursor', async () => {
      const mockCursor = {
        value: { binary: new Uint8Array([4, 5, 6]) },
        key: ['doc-prefix', '1'],
        continue: vi.fn().mockImplementation(() => {
          mockRequest.result = null
          mockRequest.onsuccess()
        }),
      }
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
        result: mockCursor,
      }
      mockStore.openCursor.mockReturnValue(mockRequest)

      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      const rangePromise = adapter.loadRange(['doc-prefix'])
      await new Promise(r => setTimeout(r, 10))

      mockRequest.onsuccess()
      const chunks = await rangePromise
      expect(chunks).toEqual([
        { key: ['doc-prefix', '1'], data: new Uint8Array([4, 5, 6]) },
      ])
      expect(mockCursor.continue).toHaveBeenCalled()
    })

    it('rejects when cursor request encounters an error', async () => {
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
        error: new Error('Cursor failed'),
      }
      mockStore.openCursor.mockReturnValue(mockRequest)

      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      const rangePromise = adapter.loadRange(['doc-prefix'])
      await new Promise(r => setTimeout(r, 10))

      mockRequest.onerror()
      await expect(rangePromise).rejects.toThrow('Cursor failed')
    })
  })
})
