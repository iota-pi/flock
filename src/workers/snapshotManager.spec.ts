import { ItemId } from 'src/shared/schemas/items'
import { SnapshotManager } from './snapshotManager'

const mockPutSnapshotsWithToken = vi.fn()

vi.mock('../api/vault/SyncWorkerClient', () => ({
  putSnapshotsWithToken: (...args: any[]) => mockPutSnapshotsWithToken(...args),
}))

vi.mock('../sync/workerAuthStore', () => ({
  getActiveSessionToken: vi.fn().mockResolvedValue('mock-auth-token'),
}))

vi.mock('src/api/vault', () => ({
  encryptBytes: vi.fn().mockResolvedValue({
    iv: 'mock-iv',
    cipher: 'mock-cipher',
    kver: '1',
  }),
}))

vi.mock('@automerge/automerge/slim', () => ({
  save: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
}))

vi.mock('../sync/docStore', async importOriginal => {
  const original = await importOriginal<typeof import('../sync/docStore')>()
  return {
    ...original,
    normalizeItemSnapshot: vi.fn().mockReturnValue({
      type: 'note',
    }),
    withAutomergeDocumentChange: vi.fn().mockResolvedValue(true),
  }
})

vi.mock('../sync/automergeRepoIds', () => ({
  toAutomergeUrlFromItemId: vi.fn().mockReturnValue('automerge:item-1'),
}))

describe('SnapshotManager Retry Mechanism', () => {
  let manager: SnapshotManager
  let mockRepo: any
  let mockHandle: any
  let context: {
    accountId: string | null
    repo: any
    adapter: any
  }

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
      adapter: {} as any,
    }

    manager = new SnapshotManager(() => context)
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
      const testManager = new SnapshotManager(() => context, { maxPayloadBytes: 200 })

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

    it('sends a single snapshot in its own batch even if it exceeds maxPayloadBytes', async () => {
      // Create a manager with extremely small maxPayloadBytes, e.g. 10 bytes
      const testManager = new SnapshotManager(() => context, { maxPayloadBytes: 10 })

      mockPutSnapshotsWithToken.mockResolvedValue({
        success: true,
        persisted: 1,
      })

      testManager.markItemDirty('item-1' as ItemId)
      testManager.scheduleSnapshotPush(42)

      await vi.runAllTimersAsync()

      // Should still be pushed in 1 call, not getting stuck.
      expect(mockPutSnapshotsWithToken).toHaveBeenCalledTimes(1)
      expect(mockPutSnapshotsWithToken.mock.calls[0][0].snapshots).toHaveLength(1)
    })
  })
})
