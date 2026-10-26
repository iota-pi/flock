import { VaultIndexedDBStorageAdapter } from './VaultIndexedDBStorageAdapter'

type Callback = (_: any) => void

const POLL = { interval: 1 }

/** Lets every pending promise callback run, for checking that something has not happened */
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

/** Waits for the adapter to attach an IndexedDB event handler, so the test can fire it */
const untilHandler = (target: Record<string, unknown>, name: string) =>
  vi.waitFor(() => expect(target[name]).toBeTypeOf('function'), POLL)

describe('VaultIndexedDBStorageAdapter', () => {
  const originalIndexedDB = globalThis.indexedDB
  let mockOpenRequest: any
  let mockDb: any
  let mockTransaction: any
  let mockStore: any

  beforeEach(() => {
    mockStore = {
      put: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      openCursor: vi.fn(),
      openKeyCursor: vi.fn(),
    }

    mockTransaction = {
      objectStore: vi.fn().mockReturnValue(mockStore),
      onerror: null,
      onabort: null,
      oncomplete: null,
      error: null,
    }

    const listeners: Record<string, Callback[]> = {}
    mockDb = {
      transaction: vi.fn().mockReturnValue(mockTransaction),
      createObjectStore: vi.fn(),
      addEventListener: vi.fn((event: string, cb: Callback) => {
        listeners[event] = listeners[event] || []
        listeners[event].push(cb)
      }),
      removeEventListener: vi.fn((event: string, cb: Callback) => {
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

  const untilConnected = () => vi.waitFor(() => {
    expect(mockDb.addEventListener).toHaveBeenCalledWith('versionchange', expect.any(Function))
  }, POLL)

  describe('read-write transaction failures', () => {
    it('rejects when transaction.onerror fires', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })

      const savePromise = adapter.save(['doc-1'], new Uint8Array([1]))
      await untilHandler(mockTransaction, 'onerror')

      const testError = new Error('Transaction failed')
      mockTransaction.error = testError
      mockTransaction.onerror()

      await expect(savePromise).rejects.toThrow('Transaction failed')
    })

    it('rejects when transaction.onabort fires', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })

      const savePromise = adapter.save(['doc-1'], new Uint8Array([1]))
      await untilHandler(mockTransaction, 'onabort')

      mockTransaction.error = null
      mockTransaction.onabort()

      await expect(savePromise).rejects.toThrow('Transaction aborted')
    })
  })

  describe('save() and remove()', () => {
    it('save() waits for transaction.oncomplete', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      let resolved = false
      const savePromise = adapter.save(['doc-1'], new Uint8Array([1, 2, 3])).then(() => {
        resolved = true
      })

      await untilHandler(mockTransaction, 'oncomplete')
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
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      let resolved = false
      const removePromise = adapter.remove(['doc-1']).then(() => {
        resolved = true
      })

      await untilHandler(mockTransaction, 'oncomplete')
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
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      let resolved = false
      const removeRangePromise = adapter.removeRange(['doc-prefix']).then(() => {
        resolved = true
      })

      await untilHandler(mockTransaction, 'oncomplete')
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

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const loadPromise = adapter.load(['doc-1'])
      await untilHandler(mockRequest, 'onsuccess')

      mockRequest.onsuccess()
      const result = await loadPromise
      expect(result).toEqual(new Uint8Array([1, 2, 3]))
      expect(mockStore.get).toHaveBeenCalledWith(['doc-1'])
    })

    it('returns undefined if result has no binary', async () => {
      const mockRequest: any = { onsuccess: null, onerror: null, result: undefined }
      mockStore.get.mockReturnValue(mockRequest)

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const loadPromise = adapter.load(['doc-1'])
      await untilHandler(mockRequest, 'onsuccess')

      mockRequest.onsuccess()
      const result = await loadPromise
      expect(result).toBeUndefined()
    })

    it('rejects when request.onerror fires', async () => {
      const mockRequest: any = { onsuccess: null, onerror: null, error: new Error('Get failed') }
      mockStore.get.mockReturnValue(mockRequest)

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const loadPromise = adapter.load(['doc-1'])
      await untilHandler(mockRequest, 'onerror')

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

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const rangePromise = adapter.loadRange(['doc-prefix'])
      await untilHandler(mockRequest, 'onsuccess')

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

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const rangePromise = adapter.loadRange(['doc-prefix'])
      await untilHandler(mockRequest, 'onerror')

      mockRequest.onerror()
      await expect(rangePromise).rejects.toThrow('Cursor failed')
    })
  })

  describe('has()', () => {
    beforeEach(() => {
      if (typeof globalThis.IDBKeyRange === 'undefined') {
        globalThis.IDBKeyRange = {
          bound: vi.fn((lower, upper) => ({ lower, upper })),
        } as any
      }
    })

    it('returns true when openKeyCursor finds a matching record without calling continue', async () => {
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
      }
      const mockCursor = {
        key: ['doc-prefix', 'snapshot', 'hash'],
        continue: vi.fn(),
      }
      mockRequest.result = mockCursor
      mockStore.openKeyCursor.mockReturnValue(mockRequest)

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const hasPromise = adapter.has(['doc-prefix'])
      await untilHandler(mockRequest, 'onsuccess')

      mockRequest.onsuccess()
      const result = await hasPromise
      expect(result).toBe(true)
      expect(mockStore.openKeyCursor).toHaveBeenCalled()
      expect(mockCursor.continue).not.toHaveBeenCalled()
    })

    it('returns false when openKeyCursor finds no matching records (null cursor)', async () => {
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
        result: null,
      }
      mockStore.openKeyCursor.mockReturnValue(mockRequest)

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const hasPromise = adapter.has(['non-existent-doc'])
      await untilHandler(mockRequest, 'onsuccess')

      mockRequest.onsuccess()
      const result = await hasPromise
      expect(result).toBe(false)
      expect(mockStore.openKeyCursor).toHaveBeenCalled()
    })

    it('falls back to openCursor when openKeyCursor is not defined on store', async () => {
      delete mockStore.openKeyCursor
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
      }
      const mockCursor = {
        key: ['doc-prefix', '1'],
        continue: vi.fn(),
      }
      mockRequest.result = mockCursor
      mockStore.openCursor.mockReturnValue(mockRequest)

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const hasPromise = adapter.has(['doc-prefix'])
      await untilHandler(mockRequest, 'onsuccess')

      mockRequest.onsuccess()
      const result = await hasPromise
      expect(result).toBe(true)
      expect(mockStore.openCursor).toHaveBeenCalled()
      expect(mockCursor.continue).not.toHaveBeenCalled()
    })

    it('handles empty keyPrefix by querying without range', async () => {
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
        result: { key: ['first-key'] },
      }
      mockStore.openKeyCursor.mockReturnValue(mockRequest)

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const hasPromise = adapter.has([])
      await untilHandler(mockRequest, 'onsuccess')

      mockRequest.onsuccess()
      const result = await hasPromise
      expect(result).toBe(true)
      expect(mockStore.openKeyCursor).toHaveBeenCalledWith(undefined)
    })

    it('rejects when cursor request encounters an error', async () => {
      const mockRequest: any = {
        onsuccess: null,
        onerror: null,
        error: new Error('KeyCursor failed'),
      }
      mockStore.openKeyCursor.mockReturnValue(mockRequest)

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const hasPromise = adapter.has(['doc-prefix'])
      await untilHandler(mockRequest, 'onerror')

      mockRequest.onerror()
      await expect(hasPromise).rejects.toThrow('KeyCursor failed')
    })
  })

  describe('close()', () => {
    it('awaits in-flight transactions before closing db', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      let saveFinished = false
      const savePromise = adapter.save(['doc-1'], new Uint8Array([1])).then(() => {
        saveFinished = true
      })

      await untilHandler(mockTransaction, 'oncomplete')
      expect(mockDb.transaction).toHaveBeenCalledWith('documents', 'readwrite')

      let closeResolved = false
      const closePromise = adapter.close().then(() => {
        closeResolved = true
      })

      // Ensure close is waiting for active transaction
      await flushPromises()
      expect(mockDb.close).not.toHaveBeenCalled()
      expect(closeResolved).toBe(false)
      expect(saveFinished).toBe(false)

      // Complete in-flight transaction
      mockTransaction.oncomplete()
      await savePromise
      expect(saveFinished).toBe(true)

      // Emit close event on database
      mockDb._emit('close')
      await closePromise
      expect(mockDb.close).toHaveBeenCalledTimes(1)
      expect(closeResolved).toBe(true)
    })

    it('rejects new transactions while closing or once closed', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const savePromise = adapter.save(['doc-1'], new Uint8Array([1]))
      await untilHandler(mockTransaction, 'oncomplete')

      const closePromise = adapter.close()

      // Attempting a new transaction while closing should immediately reject
      await expect(adapter.load(['doc-1'])).rejects.toThrow('Database is closed')

      mockTransaction.oncomplete()
      await savePromise
      mockDb._emit('close')
      await closePromise

      // Attempting a new transaction after closed should also reject
      await expect(adapter.save(['doc-1'], new Uint8Array([1, 2, 3]))).rejects.toThrow('Database is closed')
    })

    it('resolves when IDBDatabase emits close event', async () => {
      mockDb.close.mockImplementation(() => {
        mockDb._emit('close')
      })

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      await adapter.close()

      expect(mockDb.close).toHaveBeenCalledTimes(1)
    })

    it('resolves safely via fallback timer if close event is not emitted', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      // mockDb.close does not emit 'close' event
      await adapter.close()

      expect(mockDb.close).toHaveBeenCalledTimes(1)
    })

    it('is idempotent on repeated calls to close()', async () => {
      mockDb.close.mockImplementation(() => {
        mockDb._emit('close')
      })

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      const p1 = adapter.close()
      const p2 = adapter.close()

      expect(p1).toBe(p2)
      await Promise.all([p1, p2])

      expect(mockDb.close).toHaveBeenCalledTimes(1)
    })

    it('closes database connection on versionchange event', async () => {
      new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      await untilConnected()

      mockDb._emit('versionchange')

      await vi.waitFor(() => expect(mockDb.close).toHaveBeenCalled(), POLL)
    })

    it('reopens database connection on subsequent operation after versionchange event', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      await untilConnected()
      expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(1)

      // Emit versionchange on initial db connection
      mockDb._emit('versionchange')
      expect(mockDb.close).toHaveBeenCalledTimes(1)

      // Prepare a second mockDb for the reconnection
      const mockRequest2: any = {
        onsuccess: null,
        onerror: null,
        result: { binary: new Uint8Array([9, 8, 7]) },
      }
      const mockStore2 = {
        ...mockStore,
        get: vi.fn().mockReturnValue(mockRequest2),
      }
      const mockTransaction2: any = {
        objectStore: vi.fn().mockReturnValue(mockStore2),
        onerror: null,
        onabort: null,
        oncomplete: null,
        error: null,
      }
      const mockDb2 = {
        ...mockDb,
        transaction: vi.fn().mockReturnValue(mockTransaction2),
        close: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }
      mockOpenRequest.result = mockDb2

      const loadPromise = adapter.load(['doc-after-upgrade'])
      await untilHandler(mockRequest2, 'onsuccess')

      expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(2)
      expect(mockDb2.transaction).toHaveBeenCalledWith('documents', 'readonly')

      mockRequest2.onsuccess()
      const data = await loadPromise
      expect(data).toEqual(new Uint8Array([9, 8, 7]))
    })

    it('retries transaction if connection was closed concurrently with InvalidStateError', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      await untilConnected()

      // First db.transaction throws InvalidStateError (simulating race with versionchange close)
      mockDb.transaction.mockImplementationOnce(() => {
        throw new DOMException('The database connection is closing.', 'InvalidStateError')
      })

      // Reconnection returns mockDb2 which succeeds
      const mockRequest2: any = {
        onsuccess: null,
        onerror: null,
        result: { binary: new Uint8Array([42]) },
      }
      const mockStore2 = {
        ...mockStore,
        get: vi.fn().mockReturnValue(mockRequest2),
      }
      const mockTransaction2: any = {
        objectStore: vi.fn().mockReturnValue(mockStore2),
        onerror: null,
        onabort: null,
        oncomplete: null,
        error: null,
      }
      const mockDb2 = {
        ...mockDb,
        transaction: vi.fn().mockReturnValue(mockTransaction2),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }
      mockOpenRequest.result = mockDb2

      const loadPromise = adapter.load(['doc-retry'])
      await untilHandler(mockRequest2, 'onsuccess')

      expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(2)
      mockRequest2.onsuccess()

      const result = await loadPromise
      expect(result).toEqual(new Uint8Array([42]))
    })

    it('clears cached database reference on unexpected close event and reconnects on next operation', async () => {
      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      await untilConnected()
      expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(1)

      // Emit unexpected 'close' event on db (without calling adapter.close())
      mockDb._emit('close')

      const savePromise = adapter.save(['doc-1'], new Uint8Array([1, 2]))
      await untilHandler(mockTransaction, 'oncomplete')

      expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(2)
      mockTransaction.oncomplete()
      await savePromise
    })

    it('resets dbPromise on connection rejection allowing subsequent attempts to reconnect', async () => {
      // Make initial open fail
      globalThis.indexedDB = {
        open: vi.fn().mockImplementationOnce(() => {
          queueMicrotask(() => {
            mockOpenRequest.error = new Error('Initial open failed')
            if (mockOpenRequest.onerror) {
              mockOpenRequest.onerror({ target: mockOpenRequest })
            }
          })
          return mockOpenRequest
        }).mockImplementation(() => {
          queueMicrotask(() => {
            mockOpenRequest.error = null
            mockOpenRequest.result = mockDb
            if (mockOpenRequest.onsuccess) {
              mockOpenRequest.onsuccess({ target: mockOpenRequest })
            }
          })
          return mockOpenRequest
        }),
      } as any

      const adapter = new VaultIndexedDBStorageAdapter('test-db', { storeName: 'documents' })
      await vi.waitFor(() => expect((adapter as any).dbPromise).toBeNull(), POLL)

      // Subsequent operation should attempt a new connection and succeed
      const savePromise = adapter.save(['doc-1'], new Uint8Array([5]))
      await untilHandler(mockTransaction, 'oncomplete')

      expect(globalThis.indexedDB.open).toHaveBeenCalledTimes(2)
      mockTransaction.oncomplete()
      await savePromise
    })
  })
})

