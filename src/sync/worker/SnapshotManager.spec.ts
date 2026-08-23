import { ItemId } from 'src/shared/schemas/items'
import { SnapshotManager } from './SnapshotManager'
import { LastModifiedStore } from './stores/LastModifiedStore'

const mockPutSnapshotsWithToken = vi.fn()

vi.mock('../../api/vault/SyncWorkerClient', () => ({
  putSnapshotsWithToken: (...args: any[]) => mockPutSnapshotsWithToken(...args),
}))

vi.mock('../shared/workerAuthStore', () => ({
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-auth-token'),
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
  let context: {
    accountId: string | null
    repo: any
    broker: any
  }
  let lastModifiedStore: LastModifiedStore

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()

    mockHandle = {
      isReady: vi.fn().mockReturnValue(true),
      doc: vi.fn().mockReturnValue({ id: 'item-1', type: 'note' }),
    }

    mockRepo = {
      find: vi.fn().mockResolvedValue(mockHandle),
    }

    context = {
      accountId: 'test-account',
      repo: mockRepo,
      broker: {} as any,
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
      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 25,
      })

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
      const saveSpy = vi.spyOn(lastModifiedStore, 'saveLastModified')
      const clearSpy = vi.spyOn(lastModifiedStore, 'clear')

      // Set some lastModified state
      await manager.importLastModified([['item-1' as ItemId, 123456]])

      // Execute shutdown
      await manager.shutdown()

      expect(saveSpy).toHaveBeenCalledWith([['item-1', 123456]])
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
      const saveSpy = vi.spyOn(lastModifiedStore, 'saveLastModified')

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

    it('increments consecutiveBuildFailures and drops item after MAX_CONSECUTIVE_SNAPSHOT_FAILURES on real error', async () => {
      mockHandle.doc.mockReturnValue(undefined) // Triggers error in buildSnapshot

      manager.markItemDirty('item-1' as ItemId)

      // Run 5 attempts to reach MAX_CONSECUTIVE_SNAPSHOT_FAILURES (5)
      for (let i = 1; i <= 5; i++) {
        manager.scheduleSnapshotPush(42)
        await vi.advanceTimersByTimeAsync(0)
      }

      // Item should now be dropped from dirty queue
      expect(manager['dirtyItems'].has('item-1' as ItemId)).toBe(false)
      expect(manager['consecutiveFailures'].has('item-1' as ItemId)).toBe(false)
    })
  })
})

