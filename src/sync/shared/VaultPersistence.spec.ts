import { ItemId } from 'src/shared/schemas/items'

const mockReportQuotaExceeded = vi.fn()
let mockIsQuotaExceeded = false

vi.mock('../../utils/storageManager', () => ({
  runStorageOperation: vi.fn(async (op: any) => {
    try {
      return await op()
    } catch (err) {
      mockIsQuotaExceeded = true
      mockReportQuotaExceeded()
      throw err
    }
  }),
  reportQuotaExceeded: (...args: any[]) => mockReportQuotaExceeded(...args),
  checkQuotaExceeded: vi.fn(() => {
    if (mockIsQuotaExceeded) {
      mockReportQuotaExceeded()
      return true
    }
    return false
  }),
  resetQuotaExceededStatus: vi.fn(() => {
    mockIsQuotaExceeded = false
  }),
}))

function normalizeUint8Array(m: any): Uint8Array {
  if (m instanceof Uint8Array) {
    return m
  }
  if (m && typeof m === 'object') {
    const rawObj = m as any
    const length = Object.keys(rawObj).length
    const arr = Array.from({ ...rawObj, length }) as number[]
    return new Uint8Array(arr)
  }
  return new Uint8Array()
}

describe('VaultPersistence', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()

    const { getSyncBatchStorage, clearInstancesCacheForTesting, resetQuotaExceededStatus } = await import('./VaultPersistence')
    clearInstancesCacheForTesting()
    resetQuotaExceededStatus()

    // Clear stores for test accounts to avoid state pollution
    const accounts = ['acc-1', 'acc-2', 'acc-3', 'acc-4', 'acc-5', 'acc-6', 'acc-7', 'acc-8', 'acc-other']
    for (const acc of accounts) {
      await getSyncBatchStorage(acc).clear()
    }
  })

  it('persists sync messages and updates storage', async () => {
    const { persistSyncMessages, getSyncBatchStorage } = await import('./VaultPersistence')

    const writes = new Map<string, Uint8Array[]>()
    writes.set('item-1', [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    writes.set('item-2', [new Uint8Array([6])])

    await persistSyncMessages('acc-1', writes)

    // Writes map should be cleared by persistSyncMessages
    expect(writes.size).toBe(0)

    // Read stored items directly from syncBatchStorage
    const storage = getSyncBatchStorage('acc-1')
    const stored1 = await storage.getItem<Uint8Array[]>('item-1')
    const stored2 = await storage.getItem<Uint8Array[]>('item-2')

    expect(stored1).toBeDefined()
    expect(stored1).toHaveLength(2)
    expect(Array.from(normalizeUint8Array(stored1![0]))).toEqual([1, 2, 3])
    expect(Array.from(normalizeUint8Array(stored1![1]))).toEqual([4, 5])

    expect(stored2).toBeDefined()
    expect(stored2).toHaveLength(1)
    expect(Array.from(normalizeUint8Array(stored2![0]))).toEqual([6])
  })

  it('bounds messages per item to MAX_MESSAGES_PER_ITEM = 2000', async () => {
    const { persistSyncMessages, getSyncBatchStorage } = await import('./VaultPersistence')

    const list: Uint8Array[] = []
    for (let i = 0; i < 2010; i++) {
      list.push(new Uint8Array([i % 256]))
    }

    const writes = new Map<string, Uint8Array[]>()
    writes.set('item-1', list)

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await persistSyncMessages('acc-2', writes)

    expect(consoleWarnSpy).toHaveBeenCalled()

    const storage = getSyncBatchStorage('acc-2')
    const stored = await storage.getItem<Uint8Array[]>('item-1')
    expect(stored).toHaveLength(2000)
    // The stored items should be the latest 2000 ones (index 10 to 2009)
    expect(stored![0][0]).toBe(10)
    expect(stored![1999][0]).toBe(2009 % 256)

    consoleWarnSpy.mockRestore()
  })

  it('handles quota errors in persistSyncMessages by reporting error', async () => {
    const { persistSyncMessages, getSyncBatchStorage } = await import('./VaultPersistence')

    const storage = getSyncBatchStorage('acc-3')
    // Spy on setItem and make it throw a Quota Exceeded error
    const quotaError = new DOMException('quota exceeded', 'QuotaExceededError')
    const setItemSpy = vi.spyOn(storage, 'setItem').mockRejectedValue(quotaError)

    const writes = new Map<string, Uint8Array[]>()
    const msg1 = new Uint8Array([1, 2])
    writes.set('item-1', [msg1])

    await persistSyncMessages('acc-3', writes)

    expect(setItemSpy).toHaveBeenCalled()
    expect(mockReportQuotaExceeded).toHaveBeenCalled()

    // Subsequent calls to persistSyncMessages when quota is exceeded should early return
    setItemSpy.mockClear()
    mockReportQuotaExceeded.mockClear()

    writes.set('item-2', [msg1])
    await persistSyncMessages('acc-3', writes)
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(mockReportQuotaExceeded).toHaveBeenCalled() // reported again because we called it

    setItemSpy.mockRestore()
  })

  it('loads sync batch and normalizes arrays to Uint8Array', async () => {
    const { loadSyncBatch, getSyncBatchStorage } = await import('./VaultPersistence')

    // Write a serialized/raw object representation to storage (sometimes localforage/IndexedDB stores objects instead of Uint8Array directly)
    // Here we store a mix of real Uint8Array, serialized object/array, and invalid data
    const rawObj = { 0: 10, 1: 20, 2: 30 }

    const storage = getSyncBatchStorage('acc-4')
    const otherStorage = getSyncBatchStorage('acc-other')
    await storage.setItem('item-normal', [new Uint8Array([1, 2])])
    await storage.setItem('item-obj', [rawObj])
    await storage.setItem('item-invalid', [null, undefined])
    await otherStorage.setItem('item-ignored', [new Uint8Array([99])])

    const batch = await loadSyncBatch('acc-4')
    expect(batch).toHaveLength(3)

    const normalEntry = batch.find(e => e[0] === 'item-normal')
    const objEntry = batch.find(e => e[0] === 'item-obj')
    const invalidEntry = batch.find(e => e[0] === 'item-invalid')

    expect(normalEntry).toBeDefined()
    expect(normalEntry![1]).toHaveLength(1)
    expect(normalEntry![1][0]).toBeInstanceOf(Uint8Array)
    expect(Array.from(normalEntry![1][0])).toEqual([1, 2])

    expect(objEntry).toBeDefined()
    expect(objEntry![1]).toHaveLength(1)
    expect(objEntry![1][0]).toBeInstanceOf(Uint8Array)
    expect(Array.from(objEntry![1][0])).toEqual([10, 20, 30])

    expect(invalidEntry).toBeDefined()
    expect(invalidEntry![1]).toHaveLength(2)
    expect(invalidEntry![1][0]).toBeInstanceOf(Uint8Array)
    expect(invalidEntry![1][0].length).toBe(0)
  })

  it('removes sent messages or slices them properly', async () => {
    const { removeSentSyncMessages, getSyncBatchStorage } = await import('./VaultPersistence')

    const storage = getSyncBatchStorage('acc-5')
    await storage.setItem('item-1', [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ])

    // Case 1: Partial removal (slice)
    const chunkEntry1 = [
      ['item-1', [new Uint8Array([1]), new Uint8Array([2])]],
    ] as [ItemId, Uint8Array[]][]
    await removeSentSyncMessages('acc-5', chunkEntry1)

    let stored = await storage.getItem<Uint8Array[]>('item-1')
    expect(stored).toHaveLength(1)
    expect(Array.from(normalizeUint8Array(stored![0]))).toEqual([3])

    // Case 2: Complete removal
    const chunkEntry2 = [
      ['item-1', [new Uint8Array([3])]],
    ] as [ItemId, Uint8Array[]][]
    await removeSentSyncMessages('acc-5', chunkEntry2)

    stored = await storage.getItem<Uint8Array[]>('item-1')
    expect(stored).toBeNull()
  })

  it('clears sync batch for a specific account', async () => {
    const { clearSyncBatch, getSyncBatchStorage } = await import('./VaultPersistence')

    const storage6 = getSyncBatchStorage('acc-6')
    const storage7 = getSyncBatchStorage('acc-7')
    await storage6.setItem('item-1', [new Uint8Array([1])])
    await storage6.setItem('item-2', [new Uint8Array([2])])
    await storage7.setItem('item-3', [new Uint8Array([3])]) // other account

    await clearSyncBatch('acc-6')

    expect(await storage6.getItem('item-1')).toBeNull()
    expect(await storage6.getItem('item-2')).toBeNull()
    expect(await storage7.getItem('item-3')).not.toBeNull()
  })

  it('restores sync batch without deleting unprovided keys', async () => {
    const { restoreSyncBatch, getSyncBatchStorage } = await import('./VaultPersistence')

    const storage = getSyncBatchStorage('acc-8')
    await storage.setItem('item-old', [new Uint8Array([9])])

    const pendingSync = [
      ['item-1' as ItemId, [new Uint8Array([1])]],
      ['item-2' as ItemId, [new Uint8Array([2]), new Uint8Array([3])]],
    ] as [ItemId, Uint8Array[]][]

    await restoreSyncBatch('acc-8', pendingSync)

    // Old entries should be preserved
    expect(await storage.getItem('item-old')).not.toBeNull()

    // New entries should be stored
    const stored1 = await storage.getItem<Uint8Array[]>('item-1')
    const stored2 = await storage.getItem<Uint8Array[]>('item-2')

    expect(stored1).toHaveLength(1)
    expect(stored2).toHaveLength(2)
  })

  it('serializes clearSyncBatch after concurrent in-flight persistSyncMessages', async () => {
    const { persistSyncMessages, clearSyncBatch, getSyncBatchStorage } = await import('./VaultPersistence')

    const storage = getSyncBatchStorage('acc-1')
    const writes = new Map<string, Uint8Array[]>()
    writes.set('item-concur', [new Uint8Array([10, 20])])

    const clearPromise = clearSyncBatch('acc-1')
    const persistPromise = persistSyncMessages('acc-1', writes)

    await Promise.all([clearPromise, persistPromise])

    // Storage should be cleared eventually because clear was queued first
    const stored = await storage.getItem('item-concur')
    expect(stored).toBeNull()
  })

  it('serializes restoreSyncBatch with concurrent in-flight persistSyncMessages', async () => {
    const { persistSyncMessages, restoreSyncBatch, getSyncBatchStorage } = await import('./VaultPersistence')

    const storage = getSyncBatchStorage('acc-1')
    const writes = new Map<string, Uint8Array[]>()
    writes.set('item-concur', [new Uint8Array([10, 20])])

    const pendingSync: [ItemId, Uint8Array[]][] = [
      ['item-concur' as ItemId, [new Uint8Array([99])]],
    ]

    const persistPromise = persistSyncMessages('acc-1', writes)
    const restorePromise = restoreSyncBatch('acc-1', pendingSync)

    await Promise.all([persistPromise, restorePromise])

    // Restore should have executed after persist in the queue for item-concur
    const stored = await storage.getItem<Uint8Array[]>('item-concur')
    expect(stored).toHaveLength(1)
    expect(Array.from(normalizeUint8Array(stored![0]))).toEqual([99])
  })
})
