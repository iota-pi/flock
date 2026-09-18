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

    const listeners: Record<string, Function[]> = {}
    mockDb = {
      transaction: vi.fn().mockReturnValue(mockTransaction),
      createObjectStore: vi.fn(),
      addEventListener: vi.fn((event: string, cb: Function) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(cb)
      }),
      removeEventListener: vi.fn((event: string, cb: Function) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter(fn => fn !== cb)
        }
      }),
      close: vi.fn(),
      _emit: (event: string, arg?: any) => {
        if (listeners[event]) {
          for (const fn of [...listeners[event]]) {
            fn(arg)
          }
        }
      },
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
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
      }
      const mockCursor = {
        value: { binary: new Uint8Array([4, 5, 6]) },
        key: ['doc-prefix', '1'],
        continue: vi.fn().mockImplementation(() => {
          mockRequest.result = null
          mockRequest.onsuccess()
        }),
      }
      mockRequest.result = mockCursor
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

  describe('close()', () => {
    it('awaits in-flight transactions before closing db', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      let clearFinished = false
      const clearPromise = adapter.clear().then(() => {
        clearFinished = true
      })

      // Wait for transaction to initiate
      await new Promise(r => setTimeout(r, 10))
      expect(mockDb.transaction).toHaveBeenCalledWith('documents', 'readwrite')

      let closeResolved = false
      const closePromise = adapter.close().then(() => {
        closeResolved = true
      })

      // Ensure close is waiting for active transaction
      await new Promise(r => setTimeout(r, 10))
      expect(mockDb.close).not.toHaveBeenCalled()
      expect(closeResolved).toBe(false)
      expect(clearFinished).toBe(false)

      // Complete in-flight transaction
      mockTransaction.oncomplete()
      await clearPromise
      expect(clearFinished).toBe(true)

      // Emit close event on database
      mockDb._emit('close')
      await closePromise
      expect(mockDb.close).toHaveBeenCalledTimes(1)
      expect(closeResolved).toBe(true)
    })

    it('rejects new transactions while closing or once closed', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      const clearPromise = adapter.clear()
      await new Promise(r => setTimeout(r, 10))

      const closePromise = adapter.close()

      // Attempting a new transaction while closing should immediately reject
      await expect(adapter.load(['doc-1'])).rejects.toThrow('Database is closed')

      mockTransaction.oncomplete()
      await clearPromise
      mockDb._emit('close')
      await closePromise

      // Attempting a new transaction after closed should also reject
      await expect(adapter.save(['doc-1'], new Uint8Array([1, 2, 3]))).rejects.toThrow('Database is closed')
    })

    it('resolves when IDBDatabase emits close event', async () => {
      mockDb.close.mockImplementation(() => {
        mockDb._emit('close')
      })

      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      await adapter.close()

      expect(mockDb.close).toHaveBeenCalledTimes(1)
    })

    it('resolves safely via fallback timer if close event is not emitted', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      // mockDb.close does not emit 'close' event
      await adapter.close()

      expect(mockDb.close).toHaveBeenCalledTimes(1)
    })

    it('is idempotent on repeated calls to close()', async () => {
      mockDb.close.mockImplementation(() => {
        mockDb._emit('close')
      })

      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      const p1 = adapter.close()
      const p2 = adapter.close()

      expect(p1).toBe(p2)
      await Promise.all([p1, p2])

      expect(mockDb.close).toHaveBeenCalledTimes(1)
    })

    it('closes database connection on versionchange event', async () => {
      const adapter = new FlockIndexedDBStorageAdapter('test-db', 'documents')
      // Wait for connect
      await new Promise(r => setTimeout(r, 10))

      mockDb._emit('versionchange')

      // Let microtasks and close logic run
      await new Promise(r => setTimeout(r, 10))
      expect(mockDb.close).toHaveBeenCalled()
    })
  })
})
