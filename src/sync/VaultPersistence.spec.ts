import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockReportQuotaExceeded = vi.fn()
vi.mock('../workers/quotaReporter', () => ({
  reportQuotaExceeded: (...args: any[]) => mockReportQuotaExceeded(...args),
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

    const { syncBatchStorage, resetQuotaExceededStatus } = await import('./VaultPersistence')
    await syncBatchStorage.clear()
    resetQuotaExceededStatus()
  })

  it('persists sync messages and updates storage', async () => {
    const { persistSyncMessages, syncBatchStorage } = await import('./VaultPersistence')

    const writes = new Map<string, Uint8Array[]>()
    writes.set('item-1', [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])])
    writes.set('item-2', [new Uint8Array([6])])

    await persistSyncMessages('acc-1', writes)

    // Writes map should be cleared by persistSyncMessages
    expect(writes.size).toBe(0)

    // Read stored items directly from syncBatchStorage
    const stored1 = await syncBatchStorage.getItem<Uint8Array[]>('acc-1:item-1')
    const stored2 = await syncBatchStorage.getItem<Uint8Array[]>('acc-1:item-2')

    expect(stored1).toBeDefined()
    expect(stored1).toHaveLength(2)
    expect(Array.from(normalizeUint8Array(stored1![0]))).toEqual([1, 2, 3])
    expect(Array.from(normalizeUint8Array(stored1![1]))).toEqual([4, 5])

    expect(stored2).toBeDefined()
    expect(stored2).toHaveLength(1)
    expect(Array.from(normalizeUint8Array(stored2![0]))).toEqual([6])
  })

  it('bounds messages per item to MAX_MESSAGES_PER_ITEM = 2000', async () => {
    const { persistSyncMessages, syncBatchStorage } = await import('./VaultPersistence')

    const list: Uint8Array[] = []
    for (let i = 0; i < 2010; i++) {
      list.push(new Uint8Array([i % 256]))
    }

    const writes = new Map<string, Uint8Array[]>()
    writes.set('item-1', list)

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await persistSyncMessages('acc-2', writes)

    expect(consoleWarnSpy).toHaveBeenCalled()

    const stored = await syncBatchStorage.getItem<Uint8Array[]>('acc-2:item-1')
    expect(stored).toHaveLength(2000)
    // The stored items should be the latest 2000 ones (index 10 to 2009)
    expect(stored![0][0]).toBe(10)
    expect(stored![1999][0]).toBe(2009 % 256)

    consoleWarnSpy.mockRestore()
  })

  it('handles quota errors in persistSyncMessages by reporting and retaining in map', async () => {
    const { persistSyncMessages, syncBatchStorage } = await import('./VaultPersistence')

    // Spy on setItem and make it throw a Quota Exceeded error
    const quotaError = new DOMException('quota exceeded', 'QuotaExceededError')
    const setItemSpy = vi.spyOn(syncBatchStorage, 'setItem').mockRejectedValue(quotaError)

    const writes = new Map<string, Uint8Array[]>()
    const msg1 = new Uint8Array([1, 2])
    writes.set('item-1', [msg1])

    await persistSyncMessages('acc-3', writes)

    expect(setItemSpy).toHaveBeenCalled()
    expect(mockReportQuotaExceeded).toHaveBeenCalled()

    // It should put the unsaved items back in the writes map so they can be retried
    expect(writes.get('item-1')).toEqual([msg1])

    // Subsequent calls to persistSyncMessages when quota is exceeded should early return
    setItemSpy.mockClear()
    mockReportQuotaExceeded.mockClear()

    await persistSyncMessages('acc-3', writes)
    expect(setItemSpy).not.toHaveBeenCalled()
    expect(mockReportQuotaExceeded).toHaveBeenCalled() // reported again because we called it

    setItemSpy.mockRestore()
  })

  it('loads sync batch and normalizes arrays to Uint8Array', async () => {
    const { loadSyncBatch, syncBatchStorage } = await import('./VaultPersistence')

    // Write a serialized/raw object representation to storage (sometimes localforage/IndexedDB stores objects instead of Uint8Array directly)
    // Here we store a mix of real Uint8Array, serialized object/array, and invalid data
    const rawObj = { 0: 10, 1: 20, 2: 30 }
    
    await syncBatchStorage.setItem('acc-4:item-normal', [new Uint8Array([1, 2])])
    await syncBatchStorage.setItem('acc-4:item-obj', [rawObj])
    await syncBatchStorage.setItem('acc-4:item-invalid', [null, undefined])
    await syncBatchStorage.setItem('acc-other:item-ignored', [new Uint8Array([99])])

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
    const { removeSentSyncMessages, syncBatchStorage } = await import('./VaultPersistence')

    await syncBatchStorage.setItem('acc-5:item-1', [
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ])

    // Case 1: Partial removal (slice)
    const chunkEntry1: [string, Uint8Array[]][] = [
      ['item-1', [new Uint8Array([1]), new Uint8Array([2])]],
    ]
    await removeSentSyncMessages('acc-5', chunkEntry1)

    let stored = await syncBatchStorage.getItem<Uint8Array[]>('acc-5:item-1')
    expect(stored).toHaveLength(1)
    expect(Array.from(normalizeUint8Array(stored![0]))).toEqual([3])

    // Case 2: Complete removal
    const chunkEntry2: [string, Uint8Array[]][] = [
      ['item-1', [new Uint8Array([3])]],
    ]
    await removeSentSyncMessages('acc-5', chunkEntry2)

    stored = await syncBatchStorage.getItem<Uint8Array[]>('acc-5:item-1')
    expect(stored).toBeNull()
  })

  it('clears sync batch for a specific account', async () => {
    const { clearSyncBatch, syncBatchStorage } = await import('./VaultPersistence')

    await syncBatchStorage.setItem('acc-6:item-1', [new Uint8Array([1])])
    await syncBatchStorage.setItem('acc-6:item-2', [new Uint8Array([2])])
    await syncBatchStorage.setItem('acc-7:item-3', [new Uint8Array([3])]) // other account

    await clearSyncBatch('acc-6')

    expect(await syncBatchStorage.getItem('acc-6:item-1')).toBeNull()
    expect(await syncBatchStorage.getItem('acc-6:item-2')).toBeNull()
    expect(await syncBatchStorage.getItem('acc-7:item-3')).not.toBeNull()
  })

  it('restores sync batch', async () => {
    const { restoreSyncBatch, syncBatchStorage } = await import('./VaultPersistence')

    await syncBatchStorage.setItem('acc-8:item-old', [new Uint8Array([9])])

    const pendingSync: [string, Uint8Array[]][] = [
      ['item-1', [new Uint8Array([1])]],
      ['item-2', [new Uint8Array([2]), new Uint8Array([3])]],
    ]

    await restoreSyncBatch('acc-8', pendingSync)

    // Old entries should be cleared
    expect(await syncBatchStorage.getItem('acc-8:item-old')).toBeNull()

    // New entries should be stored
    const stored1 = await syncBatchStorage.getItem<Uint8Array[]>('acc-8:item-1')
    const stored2 = await syncBatchStorage.getItem<Uint8Array[]>('acc-8:item-2')

    expect(stored1).toHaveLength(1)
    expect(stored2).toHaveLength(2)
  })
})
