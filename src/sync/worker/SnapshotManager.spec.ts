import { ItemId } from 'src/shared/schemas/items'
import { SnapshotManager } from './SnapshotManager'
import { LastModifiedStore } from './stores/LastModifiedStore'
import { getActiveSessionToken } from '../shared/workerAuthStore'

const mockPutSnapshotsWithToken = vi.fn()

vi.mock('../../api/vault/SyncWorkerClient', () => ({
  putSnapshotsWithToken: (...args: any[]) => mockPutSnapshotsWithToken(...args),
}))

vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-auth-token'),
}))

const mockUpsertManualRecoveryEntry = vi.fn().mockResolvedValue(undefined)
const mockRemoveManualRecoveryEntryByItemId = vi.fn().mockResolvedValue(undefined)
const mockReadManualRecoveryEntries = vi.fn().mockResolvedValue([])
vi.mock('../shared/manualRecoveryStore', () => ({
  upsertManualRecoveryEntry: (...args: any[]) => mockUpsertManualRecoveryEntry(...args),
  removeManualRecoveryEntryByItemId: (...args: any[]) => mockRemoveManualRecoveryEntryByItemId(...args),
  readManualRecoveryEntries: (...args: any[]) => mockReadManualRecoveryEntries(...args),
}))

vi.mock('../../api/vault', () => ({
  encryptBytes: vi.fn().mockResolvedValue({
    iv: 'mock-iv',
    cipher: 'mock-cipher',
    kver: '1',
  }),
}))

vi.mock('@automerge/automerge/slim', () => ({
  save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
  getHeads: vi.fn().mockReturnValue(['mock-head']),
}))

vi.mock('./docStore', async importOriginal => {
  const original = await importOriginal<typeof import('./docStore')>()
  return {
    ...original,
    normalizeItemSnapshot: vi.fn().mockReturnValue({
      type: 'note',
    }),
    withAutomergeDocumentChange: vi.fn().mockResolvedValue(true),
  }
})

vi.mock('./utils/automerge', () => ({
  toAutomergeUrlFromItemId: vi.fn((itemId: string) => `automerge:${itemId}`),
}))

describe('SnapshotManager Retry Mechanism', () => {
  let manager: SnapshotManager
  let mockRepo: any
  let mockHandle: any
  let mockEventHub: { emit: ReturnType<typeof vi.fn> }
  let context: {
    accountId: string | null
    repo: any
    broker: any
    eventHub: any
  }
  let lastModifiedStore: LastModifiedStore

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(getActiveSessionToken).mockResolvedValue('mock-auth-token')

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    mockEventHub = {
      emit: vi.fn(),
    }

    context = {
      accountId: 'test-account',
      repo: mockRepo,
      broker: {} as any,
      eventHub: mockEventHub,
    }

    lastModifiedStore = new LastModifiedStore('test-account')
    manager = new SnapshotManager(context as any, lastModifiedStore)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('successfully pushes snapshots and clears cursor on success', async () => {
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: true,
      persisted: 1,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    // Await execution
    await vi.runAllTimersAsync()

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(manager['snapshotRequestCursor']).toBeNull()
    expect(manager['retryAttempt']).toBe(0)
  })

  it('schedules retry and retains cursor when buildSnapshot returns null (e.g. not ready)', async () => {
    mockHandle.isReady.mockReturnValue(false)

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)

    expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
    expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
    expect(manager['snapshotRequestCursor']).toBe(42)
    expect(manager['retryAttempt']).toBe(1)
    expect(manager['retryTimeoutId']).not.toBeNull()

    // When handle becomes ready on retry
    mockHandle.isReady.mockReturnValue(true)
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: true,
      persisted: 1,
    })

    await vi.advanceTimersByTimeAsync(2000)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
    expect(manager['snapshotRequestCursor']).toBeNull()
    expect(manager['retryAttempt']).toBe(0)
  })

  it('retains cursor and schedules retry when some items succeed but another returns null', async () => {
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: true,
      persisted: 1,
    })

    // item-1 is ready, item-2 is not ready
    mockRepo.find.mockImplementation((url: string) => {
      if (url.includes('item-1')) {
        return Promise.resolve({
          isReady: () => true,
          doc: () => ({ id: 'item-1', type: 'note' }),
        })
      }
      return Promise.resolve({
        isReady: () => false,
        doc: () => null,
      })
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.markItemDirty('item-2' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
    expect(manager['dirtyItems'].has('item-2' as ItemId)).toBe(true)
    expect(manager['snapshotRequestCursor']).toBe(42)
    expect(manager['retryAttempt']).toBe(1)
    expect(manager['retryTimeoutId']).not.toBeNull()
  })

  it('aggressively schedules retries with exponential backoff on failure', async () => {
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: false,
      persisted: 0,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    // Await the initial push completion
    await vi.advanceTimersByTimeAsync(0)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)

    // Attempt 1: Backoff delay = 2000ms
    expect(manager['retryAttempt']).toBe(1)
    expect(manager['retryTimeoutId']).toBeDefined()

    // Advance 1999ms, should not have retried yet
    await vi.advanceTimersByTimeAsync(1999)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)

    // Advance to 2000ms, triggers first retry (attempt 2)
    await vi.advanceTimersByTimeAsync(1)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
    expect(manager['retryAttempt']).toBe(2)

    // Attempt 2: Backoff delay = 5000ms
    await vi.advanceTimersByTimeAsync(4999)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(3)
    expect(manager['retryAttempt']).toBe(3)
  })

  it('stops early and retries if putSnapshotsWithToken throws an exception', async () => {
    mockPutSnapshotsWithToken.mockRejectedValue(new Error('Network disconnected'))

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(manager['retryAttempt']).toBe(1)

    // Should trigger first retry at 2000ms
    await vi.advanceTimersByTimeAsync(2000)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
    expect(manager['retryAttempt']).toBe(2)
  })

  it('resets the retry attempt counter to 0 on a successful retry', async () => {
    // 1. Fail first push
    mockPutSnapshotsWithToken.mockResolvedValueOnce({
      success: false,
      persisted: 0,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)
    expect(manager['retryAttempt']).toBe(1)

    // 2. Succeed on second attempt (retry)
    mockPutSnapshotsWithToken.mockResolvedValueOnce({
      success: true,
      persisted: 1,
    })

    await vi.advanceTimersByTimeAsync(2000)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
    expect(manager['retryAttempt']).toBe(0)
    expect(manager['retryTimeoutId']).toBeNull()
  })

  it('retains dirty items and schedules retry when putSnapshots returns persisted: 0 even if success is true', async () => {
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: true,
      persisted: 0,
      total: 1,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
    expect(manager['retryAttempt']).toBe(1)
    expect(manager['retryTimeoutId']).not.toBeNull()
  })

  it('retains dirty items and schedules retry when putSnapshots returns persisted less than batch length', async () => {
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: false,
      persisted: 1,
      total: 2,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.markItemDirty('item-2' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)

    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
    expect(manager['dirtyItems'].has('item-2' as ItemId)).toBe(true)
    expect(manager['retryAttempt']).toBe(1)
    expect(manager['retryTimeoutId']).not.toBeNull()
  })

  it('pauses and clears retry timers when going offline', async () => {
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: false,
      persisted: 0,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)
    expect(manager['retryAttempt']).toBe(1)
    expect(manager['retryTimeoutId']).not.toBeNull()

    // Go offline
    manager.onOnlineStateChange(false)
    expect(manager['retryTimeoutId']).toBeNull()

    // Advance time, no additional retry should occur
    await vi.advanceTimersByTimeAsync(10000)
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
  })

  it('triggers immediate push when coming online with pending snapshots', async () => {
    // 1. Set up failed push and verify it schedules a retry
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: false,
      persisted: 0,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)
    expect(manager['retryAttempt']).toBe(1)

    // 2. Go offline (clears retry timer)
    manager.onOnlineStateChange(false)
    expect(manager['retryTimeoutId']).toBeNull()

    // 3. Make next call succeed
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: true,
      persisted: 1,
    })

    // 4. Come back online
    manager.onOnlineStateChange(true)
    await vi.advanceTimersByTimeAsync(0)

    // Immediate push should have happened and succeeded
    expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
    expect(manager['retryAttempt']).toBe(0)
    expect(manager['snapshotRequestCursor']).toBeNull()
  })

  it('resets all retry properties on clear', async () => {
    mockPutSnapshotsWithToken.mockResolvedValue({
      success: false,
      persisted: 0,
    })

    manager.markItemDirty('item-1' as ItemId)
    manager.scheduleSnapshotPush(42)

    await vi.advanceTimersByTimeAsync(0)
    expect(manager['retryAttempt']).toBe(1)
    expect(manager['retryTimeoutId']).not.toBeNull()

    // Clear manager
    manager.clear()

    expect(manager['retryAttempt']).toBe(0)
    expect(manager['retryTimeoutId']).toBeNull()
    expect(manager['snapshotRequestCursor']).toBeNull()
    expect(Array.from(manager['dirtyItems'])).toHaveLength(0)
  })

  describe('Adaptive Size Batching', () => {
    it('splits batches when the count reaches 25', async () => {
      mockPutSnapshotsWithToken.mockImplementation(async (input: any) => ({
        success: true,
        persisted: input.snapshots.length,
      }))

      // Mark 30 documents dirty
      for (let i = 1; i <= 30; i++) {
        manager.markItemDirty(`item-${i}` as ItemId)
      }

      manager.scheduleSnapshotPush(42)
      await vi.runAllTimersAsync()

      // Should have been split into two calls: first with 25, second with 5.
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
      expect(mockPutSnapshotsWithToken.mock.calls[0][0].snapshots).toHaveLength(25)
      expect(mockPutSnapshotsWithToken.mock.calls[1][0].snapshots).toHaveLength(5)
    })

    it('splits batches when total estimated payload bytes exceed maxPayloadBytes', async () => {
      // Create a manager with small maxPayloadBytes, e.g. 200 bytes
      const testManager = new SnapshotManager(context as any, lastModifiedStore, { maxPayloadBytes: 200 })

      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      testManager.markItemDirty('item-1' as ItemId)
      testManager.markItemDirty('item-2' as ItemId)
      testManager.scheduleSnapshotPush(42)

      await vi.runAllTimersAsync()

      // Since each mock snapshot is ~140 bytes, two snapshots (280 bytes) will exceed 200 bytes limit.
      // So they should be pushed in 2 calls.
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
      expect(mockPutSnapshotsWithToken.mock.calls[0][0].snapshots).toHaveLength(1)
      expect(mockPutSnapshotsWithToken.mock.calls[1][0].snapshots).toHaveLength(1)
    })

    it('skips a single snapshot if it exceeds maxPayloadBytes', async () => {
      // Create a manager with extremely small maxPayloadBytes, e.g. 10 bytes
      const testManager = new SnapshotManager(context as any, lastModifiedStore, { maxPayloadBytes: 10 })

      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      testManager.markItemDirty('item-1' as ItemId)
      testManager.scheduleSnapshotPush(42)

      await vi.runAllTimersAsync()

      // Should not be pushed, and should be removed from dirtyItems to avoid retry loops
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
      expect(testManager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
    })
  })

  describe('Shutdown and Persistence', () => {
    it('persists lastModified on shutdown without clearing the persisted store', async () => {
      const saveSpy = vi.spyOn(lastModifiedStore, 'saveTimestamps')
      const clearSpy = vi.spyOn(lastModifiedStore, 'clear')

      // Set some lastModified state
      await manager.importLastModified([['item-1' as ItemId, 123456]])

      // Execute shutdown
      await manager.shutdown()

      expect(saveSpy).toHaveBeenCalledWith([['item-1', { localModifiedAt: 123456, lastSnapshotAt: 123456 }]])
      expect(clearSpy).not.toHaveBeenCalled()
    })

    it('clear() resets in-memory state without clearing the persisted store', async () => {
      const clearSpy = vi.spyOn(lastModifiedStore, 'clear')

      await manager.importLastModified([['item-1' as ItemId, 123456]])
      manager.clear()

      expect(manager.exportLastModified()).toHaveLength(0)
      expect(clearSpy).not.toHaveBeenCalled()
    })

    it('flushes dirty documents on shutdown without scheduling a dangling debounced save', async () => {
      const saveSpy = vi.spyOn(lastModifiedStore, 'saveTimestamps')

      manager.markItemDirty('item-1' as ItemId)

      await manager.shutdown()

      expect(saveSpy).toHaveBeenCalledTimes(1)

      // Advance timers to verify no dangling timer fires
      await vi.advanceTimersByTimeAsync(2000)
      expect(saveSpy).toHaveBeenCalledTimes(1)
    })
  })

  describe('In-Flight Dirty Tracking', () => {
    it('preserves dirty status if item is re-dirtied while snapshot upload is in flight', async () => {
      let resolveUpload: (val: any) => void
      const uploadPromise = new Promise(resolve => {
        resolveUpload = resolve
      })

      mockPutSnapshotsWithToken.mockImplementation(() => uploadPromise)

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)

      // Start the snapshot push
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)

      // While upload is in flight, item-1 is modified again
      manager.markItemDirty('item-1' as ItemId)

      // Complete the in-flight upload
      resolveUpload!({
        success: true,
        persisted: 1,
      })
      await vi.advanceTimersByTimeAsync(0)

      // item-1 should still be dirty because it was modified after batch preparation
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
    })

    it('clears dirty status if item was not modified during in flight upload', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)

      await vi.advanceTimersByTimeAsync(0)

      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
    })

    it('clears dirty status when item is re-dirtied after push begins but before its snapshot is built', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 2,
      })

      manager.markItemDirty('item-1' as ItemId)
      manager.markItemDirty('item-2' as ItemId)

      // When repo.find is called for item-1, simulate user modifying item-2 before item-2's snapshot is built
      const originalFind = mockRepo.find
      mockRepo.find = vi.fn().mockImplementation((url: string) => {
        if (url.includes('item-1')) {
          manager.markItemDirty('item-2' as ItemId)
        }
        return originalFind(url)
      })

      manager.scheduleSnapshotPush(42)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
      // Both item-1 and item-2 should be cleanly cleared because item-2 was built with the new tick
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
      expect(manager['dirtyItems'].has('item-2' as ItemId)).toBe(false)
    })
  })

  describe('flushPendingSnapshots with In-Flight Pushes', () => {
    it('waits for in-flight snapshot push to complete before returning', async () => {
      let resolveUpload: (val: any) => void
      const uploadPromise = new Promise(resolve => {
        resolveUpload = resolve
      })
      mockPutSnapshotsWithToken.mockImplementation(() => uploadPromise)

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)

      // Start the snapshot push
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)

      let flushed = false
      const flushPromise = manager.flushPendingSnapshots().then(res => {
        flushed = true
        return res
      })

      // Advance timers; flush should NOT have resolved yet because push is in flight
      await vi.advanceTimersByTimeAsync(0)
      expect(flushed).toBe(false)

      // Complete in-flight upload
      resolveUpload!({
        success: true,
        persisted: 1,
      })

      const result = await flushPromise
      expect(flushed).toBe(true)
      expect(result).toEqual({ persisted: 1, total: 1 })
      expect(manager['dirtyItems'].size).toBe(0)
    })

    it('flushes newly dirtied items after waiting for in-flight push to complete', async () => {
      let resolveUpload1: (val: any) => void
      const uploadPromise1 = new Promise(resolve => {
        resolveUpload1 = resolve
      })
      let resolveUpload2: (val: any) => void
      const uploadPromise2 = new Promise(resolve => {
        resolveUpload2 = resolve
      })

      mockPutSnapshotsWithToken
        .mockImplementationOnce(() => uploadPromise1)
        .mockImplementationOnce(() => uploadPromise2)

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)

      // While upload 1 is in-flight, mark item-2 dirty and call flushPendingSnapshots
      manager.markItemDirty('item-2' as ItemId)
      let flushed = false
      const flushPromise = manager.flushPendingSnapshots().then(res => {
        flushed = true
        return res
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(flushed).toBe(false)

      // Resolve upload 1
      resolveUpload1!({ success: true, persisted: 1 })
      await vi.advanceTimersByTimeAsync(0)

      // Upload 2 should now be invoked for item-2
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(2)
      expect(flushed).toBe(false)

      // Resolve upload 2
      resolveUpload2!({ success: true, persisted: 1 })
      const result = await flushPromise

      expect(flushed).toBe(true)
      expect(result).toEqual({ persisted: 2, total: 2 })
      expect(manager['dirtyItems'].size).toBe(0)
    })

    it('multiple concurrent callers of flushPendingSnapshots all wait for in-flight push', async () => {
      let resolveUpload: (val: any) => void
      const uploadPromise = new Promise(resolve => {
        resolveUpload = resolve
      })
      mockPutSnapshotsWithToken.mockImplementation(() => uploadPromise)

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)
      await vi.advanceTimersByTimeAsync(0)

      let flushed1 = false
      let flushed2 = false
      const p1 = manager.flushPendingSnapshots().then(res => {
        flushed1 = true
        return res
      })
      const p2 = manager.flushPendingSnapshots().then(res => {
        flushed2 = true
        return res
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(flushed1).toBe(false)
      expect(flushed2).toBe(false)

      resolveUpload!({ success: true, persisted: 1 })
      const [res1, res2] = await Promise.all([p1, p2])

      expect(flushed1).toBe(true)
      expect(flushed2).toBe(true)
      expect(res1).toEqual({ persisted: 1, total: 1 })
      expect(res2).toEqual({ persisted: 1, total: 1 })
    })

    it('aborts flush and returns when in-flight push fails, avoiding infinite loops', async () => {
      let resolveUpload: (val: any) => void
      const uploadPromise = new Promise(resolve => {
        resolveUpload = resolve
      })
      mockPutSnapshotsWithToken.mockImplementation(() => uploadPromise)

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)
      await vi.advanceTimersByTimeAsync(0)

      const flushPromise = manager.flushPendingSnapshots()

      // Fail the in-flight upload
      resolveUpload!({ success: false, persisted: 0 })

      const result = await flushPromise
      expect(result).toEqual({ persisted: 0, total: 1 })
      // Item remains dirty and retry is scheduled
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
      expect(manager['retryTimeoutId']).not.toBeNull()
    })

    it('shutdown awaits in-flight push if one is running', async () => {
      let resolveUpload: (val: any) => void
      const uploadPromise = new Promise(resolve => {
        resolveUpload = resolve
      })
      mockPutSnapshotsWithToken.mockImplementation(() => uploadPromise)

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)
      await vi.advanceTimersByTimeAsync(0)

      let shutdownFinished = false
      const shutdownPromise = manager.shutdown().then(() => {
        shutdownFinished = true
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(shutdownFinished).toBe(false)

      resolveUpload!({ success: true, persisted: 1 })
      await shutdownPromise

      expect(shutdownFinished).toBe(true)
    })
  })

  describe('Not-Ready vs Error Build Failure Handling', () => {
    it('does not increment consecutiveBuildFailures or drop item when handle is not ready', async () => {
      mockHandle.isReady.mockReturnValue(false)

      manager.markItemDirty('item-1' as ItemId)

      // Run 6 push attempts
      for (let i = 0; i < 6; i++) {
        manager.scheduleSnapshotPush(42)
        await vi.advanceTimersByTimeAsync(0)
      }

      // Should still be dirty and failures map should not have counted failures
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
      expect(manager['consecutiveFailures'].get('item-1' as ItemId)).toBeUndefined()
    })

    it('increments consecutiveBuildFailures and moves item to manual recovery with user notification after MAX_CONSECUTIVE_SNAPSHOT_FAILURES on real error', async () => {
      mockHandle.doc.mockReturnValue(undefined) // Triggers error in buildSnapshot
      mockReadManualRecoveryEntries.mockResolvedValueOnce([
        { id: 'item-1', itemId: 'item-1', reason: 'Snapshot failure: Document data not available', createdAt: Date.now() },
      ])

      manager.markItemDirty('item-1' as ItemId)

      // Run 5 attempts to reach MAX_CONSECUTIVE_SNAPSHOT_FAILURES (5)
      for (let i = 1; i <= 5; i++) {
        manager.scheduleSnapshotPush(42)
        await vi.advanceTimersByTimeAsync(0)
      }

      // Item should now be dropped from active dirty queue
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
      expect(manager['consecutiveFailures'].has('item-1' as ItemId)).toBe(false)

      // User notification emitted via eventHub
      expect(mockEventHub.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'snapshotFailed',
          itemId: 'item-1',
          message: expect.stringContaining('Snapshot sync failed for item item-1'),
        }),
      )

      // Persisted to manual recovery store
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith(
        'test-account',
        expect.objectContaining({
          itemId: 'item-1',
          reason: expect.stringContaining('Snapshot failure:'),
        }),
      )

      // Recovery items changed event emitted to update UI
      expect(mockEventHub.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'recoveryItemsChanged',
        }),
      )
    })

    it('does not increment failures or drop items on transient vault errors (e.g. Vault is locked)', async () => {
      const { encryptBytes } = await import('../../api/vault')
      vi.mocked(encryptBytes).mockRejectedValueOnce(new Error('Vault is locked'))

      manager.markItemDirty('item-1' as ItemId)

      // Run 6 push attempts while vault is locked
      for (let i = 0; i < 6; i++) {
        vi.mocked(encryptBytes).mockRejectedValueOnce(new Error('Vault is locked'))
        manager.scheduleSnapshotPush(42)
        await vi.advanceTimersByTimeAsync(0)
      }

      // Item must remain dirty and NOT be dropped
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
      expect(manager['consecutiveFailures'].get('item-1' as ItemId)).toBeUndefined()
      expect(mockEventHub.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'snapshotFailed' }),
      )
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
    })

    it('does not drop items or count failures when batch network send fails', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: false,
        persisted: 0,
      })

      manager.markItemDirty('item-1' as ItemId)
      manager.markItemDirty('item-2' as ItemId)

      // Run 6 push attempts where network fails
      for (let i = 0; i < 6; i++) {
        manager.scheduleSnapshotPush(42)
        await vi.advanceTimersByTimeAsync(0)
      }

      // Items must remain dirty for subsequent retry and NOT be dropped
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
      expect(manager['dirtyItems'].has('item-2' as ItemId)).toBe(true)
      expect(manager['consecutiveFailures'].has('item-1' as ItemId)).toBe(false)
      expect(manager['consecutiveFailures'].has('item-2' as ItemId)).toBe(false)
      expect(mockEventHub.emit).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'snapshotFailed' }),
      )
    })

    it('clears manual recovery entry when snapshot upload subsequently succeeds', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      manager.markItemDirty('item-1' as ItemId)
      manager.scheduleSnapshotPush(42)
      await vi.advanceTimersByTimeAsync(0)

      expect(mockRemoveManualRecoveryEntryByItemId).toHaveBeenCalledWith('test-account', 'item-1')
    })
  })

  describe('Client-Side 30s Debounce & Max-Wait', () => {
    it('pushes snapshot after 30 seconds of inactivity when an item is marked dirty', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      manager.markItemDirty('item-1' as ItemId)

      // Advance 29 seconds: should not have pushed yet
      await vi.advanceTimersByTimeAsync(29_000)
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()

      // Advance 1 second (total 30s): push executes
      await vi.advanceTimersByTimeAsync(1_000)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    })

    it('resets the 30-second timer when another item is marked dirty before the timer expires', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 2,
      })

      manager.markItemDirty('item-1' as ItemId)

      // Advance 20 seconds
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()

      // Edit another item -> resets 30s timer
      manager.markItemDirty('item-2' as ItemId)

      // Advance 20 seconds (total 40s from start, but only 20s from item-2)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()

      // Advance another 10 seconds (30s after item-2) -> pushes both items
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    })

    it('flushes after maxWait (5 minutes) even if continuous changes keep resetting the 30s timer', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      // Simulate typing every 10 seconds for 5 minutes (300 seconds)
      for (let second = 0; second < 290; second += 10) {
        manager.markItemDirty('item-1' as ItemId)
        await vi.advanceTimersByTimeAsync(10_000)
      }
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()

      // Advance to reach 300,000ms (5 minutes maxWait)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    })

    it('immediately flushes pending snapshots on flushPendingSnapshots()', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      manager.markItemDirty('item-1' as ItemId)
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()

      await manager.flushPendingSnapshots()
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    })
  })

  describe('Oversized Snapshots', () => {
    it('notifies client eventHub and records to manualRecoveryStore without silent abandonment', async () => {
      const mockEventHub = {
        emit: vi.fn(),
      }
      const managerWithLimits = new SnapshotManager(
        {
          accountId: 'test-account',
          repo: mockRepo,
          broker: {} as any,
          eventHub: mockEventHub as any,
        },
        lastModifiedStore,
        {
          // Very small limit so snapshot exceeds it
          maxPayloadBytes: 10,
        },
      )

      managerWithLimits.markItemDirty('item-1' as ItemId)
      await managerWithLimits.flushPendingSnapshots()

      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
      expect(mockEventHub.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'quotaExceeded',
          message: expect.stringContaining('exceeds the 350 KB limit'),
        }),
      )
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledWith(
        'test-account',
        expect.objectContaining({
          itemId: 'item-1',
          reason: expect.stringContaining('exceeds 350 KB limit'),
        }),
      )
    })

    it('suppresses repeated error logs and repeated manual recovery upserts on subsequent pushes for the same oversized item', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const mockEventHub = { emit: vi.fn() }
      const managerWithLimits = new SnapshotManager(
        {
          accountId: 'test-account',
          repo: mockRepo,
          broker: {} as any,
          eventHub: mockEventHub as any,
        },
        lastModifiedStore,
        { maxPayloadBytes: 10 },
      )

      managerWithLimits.markItemDirty('item-1' as ItemId)
      await managerWithLimits.flushPendingSnapshots()

      // First attempt logs error and upserts manual recovery
      const firstErrorCallCount = consoleErrorSpy.mock.calls.filter(c => String(c[0]).includes('exceeds maxPayloadBytes')).length
      expect(firstErrorCallCount).toBe(1)
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      // Re-mark dirty (e.g. from WAL re-negotiation or local change)
      managerWithLimits.markItemDirty('item-1' as ItemId)
      await managerWithLimits.flushPendingSnapshots()

      // Should NOT log error again or re-upsert manual recovery
      const secondErrorCallCount = consoleErrorSpy.mock.calls.filter(c => String(c[0]).includes('exceeds maxPayloadBytes')).length
      expect(secondErrorCallCount).toBe(1)
      expect(mockUpsertManualRecoveryEntry).toHaveBeenCalledTimes(1)

      consoleErrorSpy.mockRestore()
    })

    it('excludes quarantined oversized items from being restored to dirty queue during startup audit', async () => {
      mockReadManualRecoveryEntries.mockResolvedValueOnce([
        { id: 'item-oversized', itemId: 'item-oversized', reason: 'Snapshot size exceeds 350 KB limit', createdAt: 1000 },
      ])

      vi.spyOn(lastModifiedStore, 'loadTimestamps').mockResolvedValue([
        ['item-oversized' as ItemId, { localModifiedAt: 5000, lastSnapshotAt: 2000 }],
        ['item-normal' as ItemId, { localModifiedAt: 5000, lastSnapshotAt: 2000 }],
      ])

      await manager.loadLastModified()

      // Normal un-snapshotted item restored
      expect(manager['dirtyItems'].has('item-normal' as ItemId)).toBe(true)
      // Quarantined oversized item skipped, preventing startup audit recovery loops
      expect(manager['dirtyItems'].has('item-oversized' as ItemId)).toBe(false)
    })

    it('does not treat batch as failed or trigger retry loops when an oversized item is skipped alongside normal items', async () => {
      const { encryptBytes } = await import('../../api/vault')
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      // item-1 oversized (> 200 bytes), item-2 normal (< 200 bytes)
      vi.mocked(encryptBytes)
        .mockResolvedValueOnce({
          iv: 'mock-iv',
          cipher: 'large-cipher-payload-'.repeat(20),
          kver: '1',
        })
        .mockResolvedValueOnce({
          iv: 'mock-iv',
          cipher: 'small-cipher',
          kver: '1',
        })

      const testManager = new SnapshotManager(
        context as any,
        lastModifiedStore,
        { maxPayloadBytes: 200 },
      )

      testManager.markItemDirty('item-1' as ItemId)
      testManager.markItemDirty('item-2' as ItemId)

      await testManager.flushPendingSnapshots()

      // Only item-2 pushed
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshotsWithToken.mock.calls[0][0].snapshots[0].itemId).toBe('item-2')
      expect(testManager['dirtyItems'].size).toBe(0)
      expect(testManager['retryTimeoutId']).toBeNull()
      expect(testManager['retryAttempt']).toBe(0)
    })

    it('allows previously oversized item to sync once compacted below maxPayloadBytes', async () => {
      const { encryptBytes } = await import('../../api/vault')
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      const testManager = new SnapshotManager(
        context as any,
        lastModifiedStore,
        { maxPayloadBytes: 200 },
      )

      // Step 1: Oversized item fails snapshot (> 200 bytes)
      vi.mocked(encryptBytes).mockResolvedValueOnce({
        iv: 'mock-iv',
        cipher: 'large-cipher-payload-'.repeat(20),
        kver: '1',
      })

      testManager.markItemDirty('item-1' as ItemId)
      await testManager.flushPendingSnapshots()

      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
      expect(testManager['oversizedItems'].has('item-1' as ItemId)).toBe(true)

      // Step 2: Compaction occurs -> encrypted payload is now small (< 200 bytes)
      vi.mocked(encryptBytes).mockResolvedValueOnce({
        iv: 'mock-iv',
        cipher: 'small-cipher',
        kver: '1',
      })

      // Step 3: Marked dirty after compaction
      testManager.markItemDirty('item-1' as ItemId)
      await testManager.flushPendingSnapshots()

      // Now successfully pushed and cleared from oversizedItems
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshotsWithToken.mock.calls[0][0].snapshots[0].itemId).toBe('item-1')
      expect(testManager['oversizedItems'].has('item-1' as ItemId)).toBe(false)
      expect(testManager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
    })
  })

  describe('Missing Auth Token Handling', () => {
    it('schedules retry when getActiveSessionToken returns null and dirty items exist', async () => {
      vi.mocked(getActiveSessionToken).mockResolvedValue(null)

      manager.markItemDirty('item-1' as ItemId)
      const result = await manager.flushPendingSnapshots()

      expect(result).toEqual({ persisted: 0, total: 0 })
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
      expect(manager['retryAttempt']).toBe(1)
      expect(manager['retryTimeoutId']).not.toBeNull()
      expect(manager['consecutiveFailures'].get('item-1' as ItemId)).toBeUndefined()
    })

    it('recovers and pushes snapshots when auth token becomes available on retry', async () => {
      vi.mocked(getActiveSessionToken).mockResolvedValueOnce(null)
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      manager.markItemDirty('item-1' as ItemId)
      await manager.flushPendingSnapshots()

      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
      expect(manager['retryAttempt']).toBe(1)
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()

      // Restore auth token and advance to the first retry interval (2000ms)
      vi.mocked(getActiveSessionToken).mockResolvedValue('restored-auth-token')
      await vi.advanceTimersByTimeAsync(2000)

      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledWith(
        expect.objectContaining({
          authToken: 'restored-auth-token',
        }),
      )
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
      expect(manager['retryAttempt']).toBe(0)
    })

    it('does not schedule retry or treat as failure when dirtyItems is empty', async () => {
      vi.mocked(getActiveSessionToken).mockResolvedValue(null)

      const result = await manager.pushSnapshots()

      expect(result).toEqual({ persisted: 0, total: 0 })
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()
      expect(manager['retryTimeoutId']).toBeNull()
      expect(manager['retryAttempt']).toBe(0)
    })

    it('does not increment consecutiveFailures or move items to manual recovery when auth token is missing repeatedly', async () => {
      vi.mocked(getActiveSessionToken).mockResolvedValue(null)

      manager.markItemDirty('item-1' as ItemId)
      await manager.flushPendingSnapshots()

      // Progress through retries: 2s, 5s, 10s, 30s, 60s
      await vi.advanceTimersByTimeAsync(2000)
      await vi.advanceTimersByTimeAsync(5000)
      await vi.advanceTimersByTimeAsync(10000)
      await vi.advanceTimersByTimeAsync(30000)
      await vi.advanceTimersByTimeAsync(60000)

      expect(manager['retryAttempt']).toBe(6)
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(true)
      expect(manager['consecutiveFailures'].has('item-1' as ItemId)).toBe(false)
      expect(mockUpsertManualRecoveryEntry).not.toHaveBeenCalled()
    })
  })

  describe('Dual Timestamp & Startup Dirty Audit', () => {
    it('restores un-snapshotted items into dirtyItems on loadLastModified', async () => {
      vi.spyOn(lastModifiedStore, 'loadTimestamps').mockResolvedValue([
        ['item-unpushed' as ItemId, { localModifiedAt: 5000, lastSnapshotAt: 2000 }],
        ['item-clean' as ItemId, { localModifiedAt: 3000, lastSnapshotAt: 3000 }],
        ['item-never-snapshotted' as ItemId, { localModifiedAt: 4000 }],
      ])

      await manager.loadLastModified()

      expect(manager['dirtyItems'].has('item-unpushed' as ItemId)).toBe(true)
      expect(manager['dirtyItems'].has('item-never-snapshotted' as ItemId)).toBe(true)
      expect(manager['dirtyItems'].has('item-clean' as ItemId)).toBe(false)
      expect(manager['debounceTimer']).not.toBeNull()
    })

    it('updates lastSnapshotAt on successful snapshot push', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
        total: 1,
      })

      manager.markItemDirty('item-1' as ItemId)
      await manager.flushPendingSnapshots()

      const lastSnapshotAt = manager.getLastSnapshotAt('item-1' as ItemId)
      expect(lastSnapshotAt).toBeDefined()
      expect(typeof lastSnapshotAt).toBe('number')
      expect(lastSnapshotAt).toBeGreaterThan(0)
    })

    it('recordInboundChange updates localModifiedAt without adding to dirtyItems', () => {
      manager.recordInboundChange('item-inbound' as ItemId, 9999)

      expect(manager.getLocalModifiedAt('item-inbound' as ItemId)).toBe(9999)
      expect(manager['dirtyItems'].has('item-inbound' as ItemId)).toBe(false)
    })

    it('markItemDirty respects custom debounce delay (e.g. 2000ms)', async () => {
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
        total: 1,
      })

      manager.markItemDirty('item-1' as ItemId, 2000)

      await vi.advanceTimersByTimeAsync(1500)
      expect(mockPutSnapshotsWithToken).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(600)
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
    })
  })
})



