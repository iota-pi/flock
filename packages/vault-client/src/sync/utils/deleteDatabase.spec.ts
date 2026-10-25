import { deleteDatabase } from './deleteDatabase'

describe('deleteDatabase', () => {
  const originalIndexedDB = globalThis.indexedDB
  let mockReq: {
    onsuccess: ((event?: any) => void) | null
    onerror: ((event?: any) => void) | null
    onblocked: ((event?: any) => void) | null
    error?: Error | null
  }

  beforeEach(() => {
    mockReq = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
      error: null,
    }
    globalThis.indexedDB = {
      deleteDatabase: vi.fn().mockImplementation(() => mockReq),
    } as any
  })

  afterEach(() => {
    globalThis.indexedDB = originalIndexedDB
    vi.useRealTimers()
  })

  it('resolves when deleteDatabase succeeds immediately', async () => {
    const clearPromise = deleteDatabase('automerge-db-acc-1')
    expect(globalThis.indexedDB.deleteDatabase).toHaveBeenCalledWith('automerge-db-acc-1')
    mockReq.onsuccess?.()
    await expect(clearPromise).resolves.toBeUndefined()
  })

  it('does NOT resolve when onblocked fires; waits for onsuccess and resolves when unblocked', async () => {
    let resolved = false
    const clearPromise = deleteDatabase('acc-1').then(() => {
      resolved = true
    })

    // Simulate blocked event (e.g. open connections)
    mockReq.onblocked?.()

    // Must NOT have resolved yet
    await new Promise(r => setTimeout(r, 10))
    expect(resolved).toBe(false)

    // Simulate connection closing and deletion completing
    mockReq.onsuccess?.()
    await clearPromise
    expect(resolved).toBe(true)
  })

  it('rejects when blocked and timeout expires', async () => {
    vi.useFakeTimers()
    const clearPromise = deleteDatabase('acc-1', 1000)

    mockReq.onblocked?.()

    // Advance time past timeout
    vi.advanceTimersByTime(1000)

    await expect(clearPromise).rejects.toThrow(/deleteDatabase blocked and timed out after 1000ms/)
  })

  it('rejects when timeout expires without blocked event', async () => {
    vi.useFakeTimers()
    const clearPromise = deleteDatabase('acc-1', 1000)

    // Advance time past timeout without any event
    vi.advanceTimersByTime(1000)

    await expect(clearPromise).rejects.toThrow(/deleteDatabase timed out after 1000ms/)
  })

  it('rejects when onerror is fired', async () => {
    const clearPromise = deleteDatabase('acc-1')
    mockReq.error = new Error('IDB delete failed')
    mockReq.onerror?.()

    await expect(clearPromise).rejects.toThrow('IDB delete failed')
  })

  it('resolves immediately when indexedDB is undefined', async () => {
    globalThis.indexedDB = undefined as any
    await expect(deleteDatabase('acc-1')).resolves.toBeUndefined()
  })
})
